/**
 * upgrade-from-previous: a brain the previous release wrote upgrades in place to tonight's build, and the upgraded brain
 * still lists, writes, searches and serves. The previous CLI seeds the brain; tonight's CLI applies the pending migrations
 * as `gbrain upgrade` does after its install step (same GBRAIN_HOME and database). Then every seeded page must still list,
 * a new page must write and read back, search must find a seeded token and the new page's token, and tonight's commit,
 * installed the way users install gbrain (`bun install -g github:garrytan/gbrain#<commit>`), must answer GET /health and
 * serve an /admin page whose every script and stylesheet loads, from a directory that is not a gbrain checkout.
 *
 * Two releases it catches: a brain at schema v265 (v0.60.389.0 and v0.60.390.0) could not upgrade to any later release
 * until v0.60.466.0 (column "pending" does not exist: the upgrade replays the current schema, and one index filters on a
 * column only migration v266 adds, #7645). And until v0.60.554.0, /admin, the OAuth consent page included, was blank on
 * every installed build: admin/dist/index.html loaded a bundle the embedded asset manifest did not carry, and the SPA
 * fallback answered that bundle's URL with index.html. A gbrain checkout as the working directory hides that bug, because
 * serve then reads admin/dist from disk, so the server here runs the installed package from an empty directory.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PROVIDER_KEYS, SmokeFail, check, fail, jsonOut, rootCommit, rootVersion, seedBrain, serveHttp, tail, upgradeBrain,
  type SeededBrain, type Server, type SmokeContext,
} from './harness.ts';

/** Longest the global install may take; it downloads tonight's tree from GitHub and resolves about 180 packages. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export async function upgradeFromPrevious(ctx: SmokeContext): Promise<string> {
  const root = ctx.tonightRoot;
  // The install only needs the network, so it runs while the previous release seeds the brain. It is about 450 MB, so it
  // is removed once the smoke is done with it.
  const installDir = join(ctx.work, 'global-install');
  const install = installRelease(ctx, installDir, rootCommit(root), rootVersion(root));
  install.catch(() => {});
  try {
    return await upgradeAndCheck(ctx, install);
  } finally {
    await install.catch(() => {});
    rmSync(installDir, { recursive: true, force: true });
  }
}

async function upgradeAndCheck(ctx: SmokeContext, install: Promise<string>): Promise<string> {
  const prev = ctx.previousRoot, root = ctx.tonightRoot;
  const versions = `${rootVersion(prev)} to ${rootVersion(root)}`;
  const b = await seedBrain(ctx, prev, { seed: 21 });
  const expected = b.seed.pages.filter(p => p.kind !== 'hub').map(p => p.slug);
  const before = missingPages(await listSlugs(b, prev), expected);
  check(!before.length, 'seed_pages_missing', () => `before the upgrade, ${rootVersion(prev)} lists ${expected.length - before.length} of ${expected.length} seeded pages; missing ${before.slice(0, 5).join(', ')}`);

  await upgradeBrain(b, root);
  const after = missingPages(await listSlugs(b, root), expected);
  check(!after.length, 'pages_missing_after_upgrade', () => `after the upgrade from ${versions}, ${expected.length - after.length} of ${expected.length} seeded pages list; missing ${after.slice(0, 5).join(', ')}`);

  const slug = 'notes/written-after-upgrade';
  const token = `smk${b.seed.seed}upgradewrite`;
  const put = await b.cli(root, ['put', slug, '--source-id', b.source], { input: `---\ntype: note\ntitle: Written after upgrade\n---\n\nA page written by ${rootVersion(root)} after the upgrade. Search token ${token}.\n` });
  check(put.code === 0, 'write_failed', () => `gbrain put ${slug} after the upgrade exited ${put.code}: ${tail(put.stdout + put.stderr, 4)}`);
  const got = await b.cli(root, ['get', slug, '--source-id', b.source, '--json']);
  check(got.code === 0 && String(jsonOut<{ compiled_truth?: string }>(got)?.compiled_truth ?? '').includes(token), 'write_not_readable',
    () => `gbrain get ${slug} after a successful put did not return its text (exit ${got.code}): ${tail(got.stdout + got.stderr, 4)}`);

  const seeded = b.seed.pages.find(p => p.kind === 'person')!;
  for (const [what, query, want] of [['a seeded page', seeded.token, seeded.slug], ['the page written after the upgrade', token, slug]] as const) {
    const r = await b.cli(root, ['search', query, '--json']);
    const rows = jsonOut<Array<{ slug?: string }>>(r);
    check(r.code === 0 && Array.isArray(rows) && rows.some(x => x.slug === want), what === 'a seeded page' ? 'search_misses_seeded_page' : 'search_misses_new_page',
      () => `search "${query}" (the token of ${what}, ${want}) exited ${r.code} with ${Array.isArray(rows) ? `${rows.length} rows, none ${want}` : 'no JSON rows'}: ${tail(r.stdout + r.stderr, 3)}`);
  }

  const installed = await install;
  const cwd = join(ctx.work, 'serve-cwd');
  mkdirSync(cwd, { recursive: true });
  // Here a server that never answers GET /health is the upgraded build failing, not the harness.
  const server = await serveHttp(installed, { env: b.env, cwd, log: ctx.log })
    .catch(e => e instanceof SmokeFail && e.code === 'harness_serve_not_ready' ? fail('health_unavailable', e.detail) : Promise.reject(e));
  try {
    const assets = await checkAdmin(ctx, server);
    return `${versions}: ${expected.length} seeded pages listed, a new page wrote, read back and searched, the installed build served /health and /admin with ${assets}`;
  } finally { await server.stop(); }
}

/** Every slug `gbrain list` returns, paged so a release that caps a page of results still lists them all. */
async function listSlugs(b: SeededBrain, root: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (let offset = 0; ; ) {
    const r = await b.cli(root, ['list', '--limit', '500', '--offset', String(offset), '--json']);
    const rows = jsonOut<Array<{ slug?: string }>>(r);
    check(r.code === 0 && Array.isArray(rows), 'list_failed', () => `gbrain ${rootVersion(root)} list --offset ${offset} exited ${r.code}: ${tail(r.stdout + r.stderr, 4)}`);
    if (!rows!.length) return slugs;
    for (const x of rows!) if (x.slug) slugs.add(x.slug);
    offset += rows!.length;
  }
}

const missingPages = (listed: Set<string>, expected: string[]) => expected.filter(s => !listed.has(s));

/**
 * Installs `commit` with `bun install -g github:garrytan/gbrain#<commit>` into a private BUN_INSTALL and returns the
 * installed package's root. The install needs the network, so it gets its own small environment with no key in it
 * (and autopilot installation off, with a private HOME); the installed gbrain itself only ever runs through the keyless
 * harness. Bun's package cache is shared, so only tonight's own tree is downloaded each night.
 */
async function installRelease(ctx: SmokeContext, dir: string, commit: string, version: string): Promise<string> {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(dir, 'home'), BUN_INSTALL: join(dir, 'bun'),
    BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache'),
    GBRAIN_NO_AUTOPILOT_INSTALL: '1', NO_COLOR: '1',
  };
  const keyish = Object.keys(env).filter(k => PROVIDER_KEYS.test(k));
  if (keyish.length) fail('harness_env_not_keyless', `refusing to run bun install with ${keyish.join(', ')} in its environment`);
  const spec = `github:garrytan/gbrain#${commit}`;
  const t0 = Date.now();
  const r = await new Promise<{ code: number; out: string }>(resolve => {
    const proc = spawn('bun', ['install', '-g', spec], { env, cwd: dir });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    const timer = setTimeout(() => { out += `\n[smoke] killed after ${INSTALL_TIMEOUT_MS} ms`; proc.kill('SIGKILL'); }, INSTALL_TIMEOUT_MS);
    proc.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: out + e.message }); });
  });
  ctx.log(`$ bun install -g ${spec}  [exit ${r.code}, ${Date.now() - t0} ms]\n${tail(r.out, 20)}`);
  if (r.code !== 0) {
    // A download that never reached GitHub or the registry says nothing about gbrain; any other refusal is the package's.
    const offline = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ConnectionRefused|ConnectionClosed|ETIMEDOUT|timed out|killed after|\b(429|50[0-9])\b/i.test(r.out);
    fail(offline ? 'harness_install_unreachable' : 'install_failed', `bun install -g ${spec} exited ${r.code}: ${tail(r.out, 5)}`);
  }
  const bin = join(env.BUN_INSTALL!, 'bin', 'gbrain');
  check(existsSync(bin), 'install_no_bin', `bun install -g ${spec} succeeded but linked no gbrain binary at ${bin}`);
  const installed = dirname(dirname(realpathSync(bin)));
  const pinned = JSON.parse(readFileSync(join(env.BUN_INSTALL!, 'install', 'global', 'package.json'), 'utf8')).dependencies?.gbrain;
  check(pinned === spec && rootVersion(installed) === version, 'harness_install_wrong_build',
    () => `the global install recorded ${pinned} at version ${rootVersion(installed)}, expected ${spec} at ${version}`);
  return installed;
}

/**
 * GET /admin/, then every script and stylesheet it loads from the server itself: each must answer 200 as JavaScript or
 * CSS. Assets on other hosts (the page links a web font stylesheet) are not gbrain's to serve, so they are not fetched.
 */
async function checkAdmin(ctx: SmokeContext, server: Server): Promise<string> {
  const page = await fetch(`${server.url}/admin/`, { signal: AbortSignal.timeout(30_000) });
  const html = await page.text();
  check(page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? ''), 'admin_unavailable',
    () => `GET /admin/ answered ${page.status} ${page.headers.get('content-type')}: ${tail(html, 2).slice(0, 200)}`);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
  const assets: Array<{ url: string; kind: 'script' | 'stylesheet' }> = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) { const src = attr(tag, 'src'); if (src) assets.push({ url: src, kind: 'script' }); }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(tag, 'href');
    if (href && /(^|\s)stylesheet(\s|$)/i.test(attr(tag, 'rel') ?? '')) assets.push({ url: href, kind: 'stylesheet' });
  }
  const own = assets.filter(a => new URL(a.url, `${server.url}/admin/`).origin === server.url);
  ctx.log(`/admin/ loads ${assets.map(a => a.url).join(', ')}; checking the ${own.length} served by gbrain`);
  check(own.some(a => a.kind === 'script'), 'admin_no_bundle', () => `GET /admin/ loads no script from the server, so the admin UI cannot render: ${html.slice(0, 200)}`);
  for (const a of own) {
    const res = await fetch(new URL(a.url, `${server.url}/admin/`), { signal: AbortSignal.timeout(30_000) });
    const type = res.headers.get('content-type') ?? '';
    await res.arrayBuffer();
    ctx.log(`GET ${a.url} -> ${res.status} ${type}`);
    const ok = res.status === 200 && (a.kind === 'script' ? /javascript|ecmascript/i.test(type) : /text\/css/i.test(type));
    check(ok, 'admin_bundle_missing', `/admin/ loads the ${a.kind} ${a.url}, which answered ${res.status} ${type || '(no content type)'}, so the admin UI renders blank`);
  }
  const n = (kind: string) => own.filter(a => a.kind === kind).length;
  return `${n('script')} script(s) and ${n('stylesheet')} stylesheet(s) loading`;
}

// Fix wave 8 #5231: a legacy bearer token whose stored source list is an explicit empty list is refused for every
// operation over HTTP MCP, instead of reading the `default` source. The empty list is written straight into
// access_tokens.permissions.source_id (the stored shape both pins read), so the same setup runs at either pin.
// Exit 0 when every preregistered expectation holds (item D5).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GBRAIN_ROOT, finish, gbrain, keylessHome, src } from './lib.ts';

const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const dir = mkdtempSync(join(tmpdir(), 'w8f1-grants-'));
writeFileSync(join(dir, 'orchard-note.md'), '---\ntitle: Orchard note\n---\nThe example orchard opens in spring.\n');
await gbrain(['import', dir, '--no-embed'], h.env);
const token = async (name: string) => /(gbrain_[0-9a-f]{64})/.exec((await gbrain(['auth', 'create', name], h.env)).stdout)?.[1] ?? '';
const open = await token('example-open');
const empty = await token('example-empty');

const { PGLiteEngine } = await import(src('core/pglite-engine.ts'));
const cfg = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf8'));
const engine = new PGLiteEngine();
await engine.connect({ database_path: cfg.database_path });
await engine.executeRaw(`UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"source_id": []}'::jsonb WHERE name = 'example-empty'`);
const stored = await engine.executeRaw(`SELECT name, permissions FROM access_tokens ORDER BY name`);
await engine.disconnect();

const port = 20000 + Math.floor(Math.random() * 20000);
const serve = Bun.spawn([process.execPath, join(GBRAIN_ROOT, 'src/cli.ts'), 'serve', '--http', '--port', String(port)], { env: h.env, cwd: h.home, stdout: 'pipe', stderr: 'pipe' });
async function session(bearer: string) {
  let sid: string | null = null;
  let id = 1;
  const post = async (body: Record<string, unknown>) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` };
    if (sid) headers['mcp-session-id'] = sid;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    sid = res.headers.get('mcp-session-id') ?? sid;
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    try { return { status: res.status, msg: JSON.parse(line ? line.slice(5) : text) }; } catch { return { status: res.status, msg: { raw: text.slice(0, 400) } }; }
  };
  const init = await post({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'w8f1', version: '1' } } });
  if (init.msg?.result) await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    const text = (r.msg?.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
    return { status: r.status, refused: !!r.msg?.error || !!r.msg?.result?.isError || !r.msg?.result, text: (text || JSON.stringify(r.msg)).slice(0, 600) };
  };
  return { init: { status: init.status, ok: !!init.msg?.result, detail: JSON.stringify(init.msg).slice(0, 400) }, call };
}
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await Bun.sleep(500);
  try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { /* not up yet */ }
}
const a = await session(open);
const aSearch = a.init.ok ? await a.call('search', { query: 'example orchard' }) : null;
const b = await session(empty);
const bSearch = b.init.ok ? await b.call('search', { query: 'example orchard' }) : null;
const bGet = b.init.ok ? await b.call('get_page', { slug: 'orchard-note' }) : null;
serve.kill();
await serve.exited;
h.cleanup();

const emptyRefused = (r: typeof bSearch) => r === null || (r.refused && !r.text.includes('example orchard opens'));
finish('grants-empty-sources-5231', {
  setup_ok: ready && open !== '' && empty !== '' && a.init.ok,
  D5_open_token_reads_default: !!aSearch && !aSearch.refused && aSearch.text.includes('orchard-note'),
  D5_empty_source_token_refused_for_search: !b.init.ok || emptyRefused(bSearch),
  D5_empty_source_token_refused_for_get_page: !b.init.ok || emptyRefused(bGet),
}, { stored_permissions: stored, open_init: a.init, open_search: aSearch, empty_init: b.init, empty_search: bSearch, empty_get_page: bGet });

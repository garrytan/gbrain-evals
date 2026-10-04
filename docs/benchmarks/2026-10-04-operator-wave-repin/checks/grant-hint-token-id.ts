// gbrain #5991 (follow-up from the wave 8 re-pin): a legacy token whose stored source list is an explicit empty list is
// refused over HTTP MCP, and the refusal's fix names that token by its real id (`gbrain auth rescope-token --id <id>`)
// instead of a `<name>` placeholder. Same setup as the wave 8 check D5 (grants-empty-sources-5231.ts).
// Exit 0 when every preregistered expectation holds (item E1).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GBRAIN_ROOT, finish, gbrain, keylessHome, src } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const dir = mkdtempSync(join(tmpdir(), 'e1-grants-'));
writeFileSync(join(dir, 'orchard-note.md'), '---\ntitle: Orchard note\n---\nThe example orchard opens in spring.\n');
await gbrain(['import', dir, '--no-embed'], h.env);
const token = async (name: string) => /(gbrain_[0-9a-f]{64})/.exec((await gbrain(['auth', 'create', name], h.env)).stdout)?.[1] ?? '';
const empty = await token('example-empty');

const { PGLiteEngine } = await import(src('core/pglite-engine.ts'));
const cfg = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf8'));
const engine = new PGLiteEngine();
await engine.connect({ database_path: cfg.database_path });
await engine.executeRaw(`UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"source_id": []}'::jsonb WHERE name = 'example-empty'`);
const rows = await engine.executeRaw(`SELECT id::text AS id FROM access_tokens WHERE name = 'example-empty'`) as Array<{ id: string }>;
await engine.disconnect();
const tokenId = rows[0]?.id ?? '';

const port = 20000 + Math.floor(Math.random() * 20000);
const serve = Bun.spawn([process.execPath, join(GBRAIN_ROOT, 'src/cli.ts'), 'serve', '--http', '--port', String(port)], { env: h.env, cwd: h.home, stdout: 'pipe', stderr: 'pipe' });
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await Bun.sleep(500);
  try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { /* not up yet */ }
}
let sid: string | null = null;
let id = 1;
const post = async (body: Record<string, unknown>) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${empty}` };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  sid = res.headers.get('mcp-session-id') ?? sid;
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  try { return JSON.parse(line ? line.slice(5) : text); } catch { return { raw: text.slice(0, 2000) }; }
};
const init = await post({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e1', version: '1' } } });
if (init?.result) await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
const call = async (name: string, args: Record<string, unknown>) => {
  const m = await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
  const text = (m?.result?.content ?? []).map((c: any) => c.text ?? '').join('\n') || JSON.stringify(m?.error ?? m);
  return { refused: !!m?.error || !!m?.result?.isError || !m?.result, text: text.slice(0, 4000) };
};
const search = init?.result ? await call('search', { query: 'example orchard' }) : null;
const getPage = init?.result ? await call('get_page', { slug: 'orchard-note' }) : null;
serve.kill();
await serve.exited;
h.cleanup();

const namesId = (r: typeof search) => !!r && r.refused && tokenId !== '' && r.text.includes('rescope-token') && r.text.includes('--id') && r.text.includes(tokenId);
const noPlaceholder = (r: typeof search) => !!r && !r.text.includes('<name>');
finish('grant-hint-token-id', {
  setup_ok: ready && empty !== '' && tokenId !== '' && !!init?.result,
  E1_search_refused_and_fix_names_token_id: namesId(search),
  E1_get_page_refused_and_fix_names_token_id: namesId(getPage),
  E1_no_name_placeholder: noPlaceholder(search) && noPlaceholder(getPage),
}, { token_id: tokenId, search, get_page: getPage });

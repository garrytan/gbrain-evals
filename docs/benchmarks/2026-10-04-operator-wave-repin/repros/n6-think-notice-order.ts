// N6 at 739e5cc reports 3 existence-oracle probes, all on `think` over HTTP (callers http-read, http-write, http-bound):
// the response for a question naming a private page's token carries a `[gbrain notice synthesis_keyless]` block that
// the response for a never-written ("ghost") token lacks. This repro shows the difference follows call order, not the
// private page: gbrain #5991 dedupes notices per (transport, principal, session), N6 calls dispatchToolCall in one process
// with no session id, and it always sends the protected probe before the ghost probe.
//   bun docs/benchmarks/2026-10-04-operator-wave-repin/repros/n6-think-notice-order.ts            # both orders
// GBRAIN_ROOT selects the gbrain checkout (default: the pinned dependency). Exit 1 while the protected-first order
// produces different responses (N6's failure reproduces); the printed `follows_order` says whether the ghost-first order
// flips the difference (an ordering artifact) or keeps it on the protected token (a real oracle).
import { join, resolve } from 'node:path';

const root = process.env.GBRAIN_ROOT ? resolve(process.env.GBRAIN_ROOT) : join(import.meta.dir, '../../../../node_modules/gbrain');
for (const k of Object.keys(process.env)) if (/_API_KEY$|_BASE_URL$/.test(k)) delete process.env[k];

if (process.argv[2] === 'child') {
  const order = process.argv[3] as 'protected-first' | 'ghost-first';
  const { PGLiteEngine } = await import(join(root, 'src/core/pglite-engine.ts'));
  const { dispatchToolCall } = await import(join(root, 'src/mcp/dispatch.ts'));
  const config = { engine: 'pglite' } as Record<string, unknown>;
  const quiet = { info() {}, warn() {}, error() {} };
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const put = (slug: string, body: string) => dispatchToolCall(engine, 'put_page', { slug, content: body }, { config, logger: quiet, remote: false });
  await put('notes/private-orchard', '---\ntitle: Private orchard plan\nvisibility: private\n---\nThe zxprivateorchard plan is private.\n');
  for (let i = 0; i < 14; i++) await put(`notes/public-${i}`, `---\ntitle: Public note ${i}\n---\nA public note about orchards number ${i}.\n`);
  const auth = { token: 'repro', clientId: 'repro-reader', principal: { kind: 'oauth_client', id: 'repro-reader' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default'], hasSourceGrant: true };
  const think = async (question: string) => {
    const r = await dispatchToolCall(engine, 'think', { question, since: '2000-01-01', until: '2100-01-01' }, { config, logger: quiet, remote: true, transport: 'http', sourceId: 'default', auth, takesHoldersAllowList: ['world'] });
    return (r.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
  };
  const tokens = { protected: 'zxprivateorchard', ghost: 'zxghostorchardnever' };
  const seq = order === 'protected-first' ? ['protected', 'ghost'] as const : ['ghost', 'protected'] as const;
  const out: Record<string, boolean> = {};
  for (const which of seq) out[which] = (await think(tokens[which])).includes('[gbrain notice synthesis_keyless');
  await engine.disconnect();
  console.log(JSON.stringify({ order, notice_on_protected: out.protected, notice_on_ghost: out.ghost }));
  process.exit(0);
}

const run = (order: string) => {
  const p = Bun.spawnSync([process.execPath, import.meta.path, 'child', order], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const line = p.stdout.toString().trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(line); } catch { throw new Error(`child ${order} failed: ${p.stderr.toString().slice(-800)}`); }
};
const a = run('protected-first');
const b = run('ghost-first');
const version = (await Bun.file(join(root, 'package.json')).json()).version;
const differsProtectedFirst = a.notice_on_protected !== a.notice_on_ghost;
const followsOrder = differsProtectedFirst && b.notice_on_protected !== b.notice_on_ghost && b.notice_on_ghost === a.notice_on_protected;
console.log(JSON.stringify({ gbrain_version: version, protected_first: a, ghost_first: b, n6_difference_reproduces: differsProtectedFirst, follows_order: followsOrder }));
process.exit(differsProtectedFirst ? 1 : 0);

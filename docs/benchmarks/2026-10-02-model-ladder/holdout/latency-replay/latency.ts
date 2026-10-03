import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBuild } from '../../../../../eval/runner/lifecycle/builds.ts';
import { GbrainSlot, MeteringProxy } from '../../../../../eval/runner/cat40/gbrain-arm.ts';

const [ref, label, phase] = process.argv.slice(2);
const root = join(process.env.HOME!, '.capy/work/cat40/diag');
const world = JSON.parse(readFileSync('eval/data/model-ladder-v1/world.json', 'utf8'));
const build = prepareBuild(process.env.GBRAIN_REPO ?? '../gbrain', { label: `build-${label}`, ref, description: label }, join(root, 'builds'));
const proxy = new MeteringProxy(); proxy.start();
const slot = new GbrainSlot('slot0', join(root, `slots-${label}`), build.dir, proxy.port, 'starter');
if (!slot.hasSnapshot()) { const b = await slot.build(world, proxy, false); console.log('built', label, b.steps.map(s => `${s.step}:${(s.ms/1000).toFixed(0)}s`).join(' ')); }
await slot.restore();
if (phase === 'analyze') {
  await slot.stop();
  const pglite = join(build.dir, 'node_modules/@electric-sql/pglite/dist');
  const t = Date.now();
  execFileSync('bun', ['-e', `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(slot.dir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); await db.exec('ANALYZE'); await db.close();`]);
  console.log('operator ANALYZE ms', Date.now() - t);
  await slot.start();
}
const ms = async (name: string, args: Record<string, unknown>) => { const t = Date.now(); const r = await slot.client!.call(name, args); return { ms: Date.now() - t, head: r.slice(0, 120).replace(/\s+/g, ' ') }; };
const qs = ['payment terms Murari Logistics', 'who owns the Brightcrest account', 'discount approval policy', 'renewal date for Kestrel', 'data retention clause', 'support tier for enterprise customers'];
const out: Record<string, unknown> = { label, commit: build.commit.slice(0, 10), phase };
const s: number[] = [];
for (const q of qs) s.push((await ms('search', { query: q })).ms);
out.search = s;
const g: number[] = [];
for (const slug of world.docs.slice(0, 5).map((d: any) => d.id)) g.push((await ms('get_page', { slug })).ms);
out.get_page = g;
const pp = await ms('put_page', { slug: 'notes/diag-write', content: '---\ntitle: "diag write"\ntype: note\n---\nOndronex billing contact changed.\n' });
out.put_page = pp;
const r1 = await ms('remember', { fact: 'Acme example billing contact is now Dana Example', entity: 'companies/acme-example', provenance: 'latency diag' }).catch(e => ({ ms: -1, head: String(e) }));
out.remember = r1;
const crm = world.docs.find((d: any) => d.id.startsWith('crm/'));
const ent = crm.title.split(':').pop().trim();
out.entity = ent;
const rs: unknown[] = [];
for (let i = 0; i < 3; i++) rs.push(await ms('remember', { fact: `${ent} billing contact note ${i}: contact is Person ${i} Example`, entity: ent, provenance: 'latency diag' }));
out.remember_entity = rs;
const s2: number[] = [];
for (const q of qs.slice(0, 3)) s2.push((await ms('search', { query: q })).ms);
out.search_after_write = s2;
out.stderr_tail = slot.client!.stderr.slice(-5);
console.log(JSON.stringify(out));
await slot.stop(); proxy.stop();

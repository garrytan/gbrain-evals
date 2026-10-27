// search latency during sync, in-process (serve model). usage: [PG_URL=..] bun search-during-sync.ts <root> <work-dir> [pages]
import { execFileSync as cpExec } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
const [root, work, pagesArg] = process.argv.slice(2);
const pages = Number(pagesArg ?? 10000);
for (const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','VOYAGE_API_KEY','GEMINI_API_KEY','DATABASE_URL','GBRAIN_DATABASE_URL']) delete process.env[k];
process.env.GBRAIN_HOME = join(work, 'home'); mkdirSync(process.env.GBRAIN_HOME, { recursive: true });
const pagePath = (pfx: string, i: number) => pfx + '/d' + String(Math.floor(i / 1000)).padStart(3, '0') + '/n-' + String(i).padStart(6, '0') + '.md';
const words = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa'];
const content = (pfx: string, i: number, s = 'baseline') => '---\ntitle: Note ' + pfx + ' ' + i + '\ntype: note\n---\n# Note ' + i + '\n\nStatus: ' + s + '. Topic ' + words[i % 16] + ' ' + words[(i * 7) % 16] + ' ' + words[(i * 13) % 16] + '.\n\nSee [[' + pagePath(pfx, (i + 1) % pages).replace(/\.md$/, '') + ']].\n';
function repo(name: string, pfx: string) {
  const r = join(process.env.REPOS ?? work, name); const g = (...a: string[]) => cpExec('git', ['-C', r, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', ...a], { encoding: 'utf8' }).trim();
  if (!existsSync(join(r, '.git'))) {
    mkdirSync(r, { recursive: true }); g('init', '-q', '-b', 'main');
    for (let i = 0; i < pages; i++) { const p = join(r, pagePath(pfx, i)); if (i % 1000 === 0) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content(pfx, i)); }
    writeFileSync(join(r, '.gitignore'), '\n'); g('add', '-A'); g('commit', '-qm', 'init');
  }
  return { r, g };
}
const A = repo('repo-a', 'a'), B = repo('repo-b', 'b');
const PG = process.env.PG_URL;
const imp = (p: string) => import(join(root, p));
const { PGLiteEngine } = await imp('src/core/pglite-engine.ts');
const { PostgresEngine } = await imp('src/core/postgres-engine.ts');
const { performSync } = await imp('src/commands/sync.ts');
const { claimWorktree } = await imp('src/core/persistence/ownership.ts');
const { activateSharedSkillPersistence } = await imp('src/core/persistence/skill-activation.ts');
const { disposePersistenceConsumer } = await imp('src/core/persistence/service.ts');
const { searchOperations } = await imp('src/core/ops/search.ts');
const { watchLoopLag, threadCpuNow } = await imp('test/helpers/cpu-time.ts');
const searchOp = searchOperations.find((o: any) => o.name === 'search');
const engine = PG ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(PG ? { database_url: PG } : { database_path: join(work, 'brain.pglite') }); await engine.initSchema();
const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
const [have] = await engine.executeRaw("SELECT count(*)::int AS n FROM sources WHERE id='srca'");
if (!have.n) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  for (const [id, r] of [['srca', A.r], ['srcb', B.r]]) { await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, r]); await claimWorktree(engine, id, r); }
  await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
  const t = performance.now(); await performSync(engine, { sourceId: 'srca', repoPath: A.r, noPull: true, noEmbed: true, drain: true }); console.error('setup: first sync A', Math.round(performance.now() - t), 'ms');
}
const sync = (id: string, r: string) => performSync(engine, { sourceId: id, repoPath: r, noPull: true, noEmbed: true, drain: true });
let qn = 0;
const query = () => { qn++; return qn % 3 === 0 ? 'Note a ' + ((qn * 977) % pages) : words[qn % 16] + ' ' + words[(qn * 5) % 16]; };
async function oneSearch(due?: number): Promise<{ wall: number; cpu: number; resp: number }> {
  const t = performance.now(), c = threadCpuNow();
  await searchOp.handler(ctx, { query: query(), limit: 10, source_id: 'srca' });
  const end = performance.now();
  return { wall: end - t, cpu: threadCpuNow() - c, resp: end - (due ?? t) };
}
const GAP = Number(process.env.GAP_MS ?? 250);
// Open-loop pacing: a search is due every GAP ms whether or not the last one finished, and its response time runs
// from its due time, so a stall of the event loop counts against every search that came due during it.
async function paced(n: number | null, doneAt: () => number | null) {
  const pending: Array<Promise<{ wall: number; cpu: number; resp: number }>> = []; const start = performance.now();
  for (let k = 0; ; k++) {
    const due = start + k * GAP;
    if (n !== null && k >= n) break;
    const wait = due - performance.now(); if (wait > 0) await Bun.sleep(wait);
    const d = doneAt(); if (n === null && d !== null && due > d) break;
    pending.push(oneSearch(due));
  }
  return Promise.all(pending);
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const summary = (label: string, xs: Array<{ wall: number; cpu: number; resp: number }>, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ engine: engine.kind, cell: label, n: xs.length, resp_p50: pct(xs.map(x => x.resp), 0.5), resp_p95: pct(xs.map(x => x.resp), 0.95), resp_max: pct(xs.map(x => x.resp), 1), service_p50: pct(xs.map(x => x.wall), 0.5), service_p95: pct(xs.map(x => x.wall), 0.95), cpu_p50: pct(xs.map(x => x.cpu), 0.5), ...extra }));
async function idle(label: string, n = 60) { for (let i = 0; i < 10; i++) await oneSearch(); summary(label, await paced(n, () => null)); }
async function during(label: string, start: () => Promise<unknown>) {
  const lag = watchLoopLag(5); let doneAt: number | null = null; const t = performance.now();
  const p = start().finally(() => { doneAt = performance.now(); });
  const xs = await paced(null, () => doneAt);
  await p; const l = lag.stop();
  return { xs, syncMs: performance.now() - t, maxLagCpuMs: Math.round(l.maxLag), ticks: l.ticks };
}
await idle('idle-10k');
const mod = { xs: [] as any[], syncs: [] as number[], lag: [] as number[], ticks: [] as number[] };
for (let rep = 0; rep < Number(process.env.REPS ?? 8); rep++) {
  for (let k = 0; k < 100; k++) { const i = (rep * 1237 + k * 97) % pages; writeFileSync(join(A.r, pagePath('a', i)), content('a', i, 'edited ' + rep + ' ' + Date.now())); }
  A.g('commit', '-qam', 'edit ' + rep);
  const d = await during('commit100', () => sync('srca', A.r));
  mod.xs.push(...d.xs); mod.syncs.push(Math.round(d.syncMs)); mod.lag.push(d.maxLagCpuMs); mod.ticks.push(d.ticks);
}
summary('during-commit100', mod.xs, { sync_ms: mod.syncs, max_loop_lag_cpu_ms: mod.lag, ticks: mod.ticks });
const f = await during('first-sync-10k', () => sync('srcb', B.r));
summary('during-first-sync', f.xs, { sync_ms: Math.round(f.syncMs), max_loop_lag_cpu_ms: f.maxLagCpuMs, ticks: f.ticks });
await idle('idle-after');
await disposePersistenceConsumer(engine); await engine.disconnect();
process.exit(0);

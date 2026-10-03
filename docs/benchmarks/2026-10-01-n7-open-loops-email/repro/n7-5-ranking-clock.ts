// N7-5 (feature gap): open_loops ranks with Date.now(); the same rows give a different order two days later and no parameter pins the clock.
import { G } from './_thread.ts';
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const { upsertOpenLoop } = await import(`${G}/loops/loops-store.ts`);
const { operations } = await import(`${G}/operations.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ('g', 'g', '{"kind":"google"}'::jsonb, now())`);
const T = Date.parse('2026-10-01T12:00:00Z'); const D = 86_400_000;
await upsertOpenLoop(engine, { sourceId: 'g', dedupKey: 'a', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.org', summary: 'a', evidence: [], detector: 'llm_extract', dueAt: new Date(T + 8 * D).toISOString() });
await upsertOpenLoop(engine, { sourceId: 'g', dedupKey: 'b', loopType: 'commitment_owed_to_me', counterpartyEmail: 'b@example.org', summary: 'b', evidence: [], detector: 'llm_extract' });
await engine.executeRaw(`UPDATE open_loops SET opened_at = CASE dedup_key WHEN 'a' THEN $1::timestamptz ELSE $2::timestamptz END`, [new Date(T).toISOString(), new Date(T - 10 * D).toISOString()]);
const op = operations.find((o: any) => o.name === 'open_loops');
const ctx: any = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'g' };
const order = async (ms: number) => { const real = Date.now; Date.now = () => ms; try { return ((await op.handler(ctx, { include_context: false, limit: 10 })) as any).groups.map((g: any) => g.counterparty); } finally { Date.now = real; } };
console.log(`expected: one reproducible order for these two rows (or a way to pin the reference time)\nactual:   at T ${JSON.stringify(await order(T))}; at T+2d ${JSON.stringify(await order(T + 2 * D))}`);
await engine.disconnect();

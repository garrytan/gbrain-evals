// N7-5 check at the wave 7 pin: the N7-5 repro's rows ranked with open_loops as_of pinned give one order whatever the wall clock says.
// Exit 1 when the pinned order still moves with the clock (or as_of is refused).
const G = new URL('../../../../node_modules/gbrain/src/core', import.meta.url).pathname;
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
const order = async (wallMs: number, asOf?: string) => { const real = Date.now; Date.now = () => wallMs; try { return ((await op.handler(ctx, { include_context: false, limit: 10, ...(asOf ? { as_of: asOf } : {}) })) as any).groups.map((g: any) => g.counterparty); } finally { Date.now = real; } };
const asOf = new Date(T).toISOString();
const unpinned = [await order(T), await order(T + 2 * D)];
const pinned = [await order(T, asOf), await order(T + 2 * D, asOf)];
console.log(JSON.stringify({ unpinned: { at_T: unpinned[0], at_T_plus_2d: unpinned[1] }, pinned_as_of: asOf, pinned: { wall_T: pinned[0], wall_T_plus_2d: pinned[1] } }));
await engine.disconnect();
process.exit(JSON.stringify(pinned[0]) === JSON.stringify(pinned[1]) && JSON.stringify(pinned[0]) === JSON.stringify(unpinned[0]) ? 0 : 1);

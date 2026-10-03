// N7-6 check at the wave 7 pin: a loop's opened_at is the request message's time, not the time gbrain detected it.
// Two requests (720 h and 30 h old) found in one sync. Exit 1 while opened_at is the detection time.
const G = new URL('../../../../node_modules/gbrain/src/core', import.meta.url).pathname;
const { applyThreadLoopVerdict } = await import(`${G}/google/loop-detect.ts`);
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const NOW = new Date('2026-10-01T12:00:00Z'); const H = 3_600_000; const ME = new Set(['me@example.com']);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g', 'g', '{"kind":"google"}'::jsonb)`);
const want: Record<string, string> = {};
for (const [id, age] of [['old', 720], ['new', 30]] as const) {
  const sent = NOW.getTime() - age * H; want[id] = new Date(sent).toISOString();
  const m = { id, threadId: id, from: `${id}@example.org`, fromAddress: `${id}@example.org`, to: ['me@example.com'], cc: [], subject: 'Review', dateIso: '', internalDateMs: sent, labelIds: ['INBOX'], listUnsubscribe: false, calendarMethod: null, bodyText: 'Can you review this?' };
  await applyThreadLoopVerdict(engine, 'g', { threadId: id, account: 'me@example.com', messages: [m] }, ME, null, NOW);
}
const rows = await engine.executeRaw(`SELECT thread_id, opened_at FROM open_loops ORDER BY thread_id`);
const got = Object.fromEntries(rows.map((r: any) => [r.thread_id, new Date(r.opened_at).toISOString()]));
console.log(JSON.stringify({ request_time: want, opened_at: got }));
await engine.disconnect();
process.exit(got.old === want.old && got.new === want.new ? 0 : 1);

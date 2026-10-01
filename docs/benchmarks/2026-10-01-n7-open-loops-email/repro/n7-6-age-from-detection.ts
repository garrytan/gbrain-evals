// N7-6 (feature gap): ranking age is time since detection, so a 30-day-old request and a 30-hour-old one detected in one sync are equally "old".
import { G, ME, NOW, msg, thread } from './_thread.ts';
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const { applyThreadLoopVerdict } = await import(`${G}/google/loop-detect.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g', 'g', '{"kind":"google"}'::jsonb)`);
for (const [id, age] of [['old', 720], ['new', 30]] as const) {
  const t = thread(msg({ id, from: `${id}@example.org`, to: ['me@example.com'], ageH: age, body: 'Can you review this?' }));
  await applyThreadLoopVerdict(engine, 'g', { ...t, threadId: id }, ME, null, NOW);
}
const rows = await engine.executeRaw(`SELECT thread_id, opened_at, last_activity_at FROM open_loops ORDER BY thread_id`);
for (const r of rows) console.log(`${r.thread_id}: opened_at=${new Date(r.opened_at).toISOString()} last_activity_at=${new Date(r.last_activity_at).toISOString()}`);
console.log('expected: the 720-hour request ranks older than the 30-hour one\nactual:   opened_at (the ranking input) is the detection time for both');
await engine.disconnect();

// N7-3 (feature gap): nothing closes an extracted commitment when a later message fulfils it.
import { G, ME, NOW, msg, thread } from './_thread.ts';
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const { upsertOpenLoop } = await import(`${G}/loops/loops-store.ts`);
const { applyThreadLoopVerdict } = await import(`${G}/google/loop-detect.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g', 'g', '{"kind":"google"}'::jsonb)`);
await upsertOpenLoop(engine, { sourceId: 'g', dedupKey: 'commit:deck', loopType: 'commitment_owed_by_me', counterpartyEmail: 'bob@example.org', summary: 'Send Bob the deck by Friday', evidence: [], threadId: 't1', detector: 'llm_extract', dueAt: '2026-10-03T00:00:00Z' });
await applyThreadLoopVerdict(engine, 'g', thread(
  msg({ id: 'c1', from: 'bob@example.org', to: ['me@example.com'], ageH: 60, body: 'Can you send the deck?' }),
  msg({ id: 'c2', from: 'me@example.com', to: ['bob@example.org'], ageH: 50, body: 'I will send it by Friday.', mine: true }),
  msg({ id: 'c3', from: 'me@example.com', to: ['bob@example.org'], ageH: 30, body: 'As promised, here is the deck.', mine: true }),
), ME, null, NOW);
const [row] = await engine.executeRaw(`SELECT status FROM open_loops WHERE dedup_key = 'commit:deck'`);
console.log(`expected: commitment loop closed after "As promised, here is the deck."\nactual:   status=${row.status} (reply auto-close touches deterministic_thread loops only; re-extraction only upserts)`);
await engine.disconnect();

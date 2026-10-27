#!/usr/bin/env bun
/**
 * D7 in-container brain helper, run as the agent user against the gbrain build under test (/opt/gbrain) while no
 * other process holds the brain.
 *
 *   bun brief-db.ts backdate <since-iso> <at-iso>
 *     Dates every fact, timeline entry and page revision written since <since> at <at> (the aged condition).
 *   bun brief-db.ts replay <base64 {"prompt": "..."}>
 *     Times the brief work for the scenario prompt on this brain: the full turn_context assembly as the serve runs it
 *     (with its 300 ms brief cutoff) and the brief alone with no cutoff, five times each, cold first.
 *
 * Prints one JSON line.
 */
export {};
const GB = "/opt/gbrain/src";

async function connect() {
  const { loadConfig, toEngineConfig } = await import(`${GB}/core/config.ts`);
  const { createEngine } = await import(`${GB}/core/engine-factory.ts`);
  const cfg = loadConfig();
  if (!cfg) throw new Error('no gbrain config');
  const engine = await createEngine(toEngineConfig(cfg));
  await engine.connect(toEngineConfig(cfg));
  return engine;
}

async function backdate(since: string, at: string) {
  const engine = await connect();
  try {
    // The append-only guards (P0001) reject history edits; replica mode skips triggers for this one evaluator write.
    await engine.executeRaw('SET session_replication_role = replica');
    const q = async (sql: string) => (await engine.executeRaw(sql, [since, at]) as unknown[]).length;
    const facts = await q(`UPDATE facts SET created_at = $2::timestamptz, valid_from = CASE WHEN valid_from >= $1::timestamptz THEN $2::timestamptz ELSE valid_from END WHERE created_at >= $1::timestamptz RETURNING id`);
    const timeline = await q(`UPDATE timeline_entries SET created_at = $2::timestamptz WHERE created_at >= $1::timestamptz RETURNING id`);
    const versions = await q(`UPDATE page_versions SET snapshot_at = $2::timestamptz WHERE snapshot_at >= $1::timestamptz RETURNING id`);
    console.log(JSON.stringify({ facts, timeline, versions }));
  } finally { await engine.disconnect(); }
}

async function replay(prompt: string) {
  const engine = await connect();
  try {
    const { turnContextWithBrief } = await import(`${GB}/mcp/resolve-ipc-binding.ts`);
    const { turnBrief, briefEnabled, TURN_BRIEF_CUTOFF_MS } = await import(`${GB}/core/context/proactive-brief.ts`);
    const source = 'default';
    const enabled = await briefEnabled(engine);
    const full: Array<{ ms: number; brief_items: number }> = [];
    const alone: Array<{ ms: number; brief_items: number }> = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now();
      const r = await turnContextWithBrief(engine, source, { window: [{ role: 'user', text: prompt }], sessionId: `d7-replay-${i}` });
      full.push({ ms: Math.round(performance.now() - t), brief_items: r.brief?.items?.length ?? 0 });
      t = performance.now();
      const now = Date.now();
      const b = await turnBrief(engine, { sourceId: source, prompt, sessionId: `d7-replay-alone-${i}`, clock: { now, stopAt: now + 60_000 } });
      alone.push({ ms: Math.round(performance.now() - t), brief_items: b?.items?.length ?? 0 });
    }
    console.log(JSON.stringify({ cutoff_ms: TURN_BRIEF_CUTOFF_MS, switch_on: enabled, turn_context: full, brief_alone: alone }));
  } finally { await engine.disconnect(); }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'backdate') await backdate(a, b);
else if (cmd === 'replay') await replay((JSON.parse(Buffer.from(a, 'base64').toString('utf8')) as { prompt: string }).prompt);
else { console.error('usage: brief-db.ts backdate <since> <at> | replay <base64 json>'); process.exit(2); }
process.exit(0);

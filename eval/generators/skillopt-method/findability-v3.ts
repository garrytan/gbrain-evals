#!/usr/bin/env bun
/**
 * The findability control of skillopt-method-v3 revision 1 (rev1-v3.ts):
 * gbrain's own search, run on every revision-1 candidate's question text the
 * way a rollout runs it (the `brain_search` tool handler of gbrain's rollout,
 * at the pinned gbrain, embeddings off, the clock set to the world's present),
 * with the distinct page slugs it returns written to findability-v3-rev1.jsonl.
 * Generation reads that file, so it stays byte for byte and needs no database;
 * the file's header names the world it was searched on, and generation refuses
 * a file searched on another.
 *
 *   bun eval/generators/skillopt-method/findability-v3.ts write [--fresh]  # search every probe of every revision-1 draft and write the file; without
 *                                                                          # --fresh, a query the file already holds for this world and gbrain keeps its hits
 *   bun eval/generators/skillopt-method/findability-v3.ts check [N]   # re-search N cached queries (default every one) and exit 1 on any difference
 *
 * Keyless: no model call; the rollout's tool loop is replaced by one that
 * calls the search tool once.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRollout } from 'gbrain/core/skillopt';
import { openBrain } from '../../runner/skillopt-method/headroom.ts';
import { Rng } from '../seeded.ts';
import { briefingV3Rev1Drafts, BRIEFING_V3_SEED } from './briefing-v3.ts';
import { loadWorldV3 } from './common-v3.ts';
import { factCheckV3Rev1Drafts, FACT_CHECK_V3_SEED } from './fact-check-v3.ts';
import { queryV3Rev1Drafts, QUERY_V3_SEED } from './query-v3.ts';
import { FINDABILITY, FINDABILITY_CACHE_PATH, loadFindabilityCache, probeQueries, worldHash, type FindabilityHeader } from './rev1-v3.ts';
import { DEFAULT_V3_KNOBS, type V3Knobs } from './world-v3.ts';

export const REV1_KNOBS: V3Knobs = { ...DEFAULT_V3_KNOBS, revision: 1 };
const GBRAIN = (() => {
  const root = join(import.meta.dir, '../../../node_modules/gbrain/package.json');
  const pin = /gbrain#([0-9a-f]{9})/.exec(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'))?.[1] ?? 'unknown';
  return `${(JSON.parse(readFileSync(root, 'utf8')) as { version: string }).version} (${pin})`;
})();

/** Every query the revision-1 drafts of the three skills search, sorted. */
export function rev1ProbeQueries(knobs: V3Knobs = REV1_KNOBS): string[] {
  const corpus = loadWorldV3(knobs);
  return [...new Set([
    ...probeQueries(queryV3Rev1Drafts(corpus, new Rng(QUERY_V3_SEED))),
    ...probeQueries(briefingV3Rev1Drafts(corpus, new Rng(BRIEFING_V3_SEED))),
    ...probeQueries(factCheckV3Rev1Drafts(corpus, new Rng(FACT_CHECK_V3_SEED))),
  ])].sort();
}

/** A brain over `pages` and the search a rollout runs on it, with the clock at the world's present while each search runs. */
export async function openSearch(pages: ReadonlyMap<string, string>): Promise<{ search: (query: string) => Promise<string[]>; close: () => Promise<void> }> {
  const engine = await openBrain('v3', pages);
  const clock = Date.parse(FINDABILITY.clock);
  const realNow = Date.now;
  const search = async (query: string): Promise<string[]> => {
    let rows: Array<{ slug: string }> = [];
    const started = realNow();
    Date.now = () => clock + (realNow() - started);
    try {
      await runRollout({
        engine, skillText: '', task: { task_id: 'findability', task: query } as never, targetModel: 'anthropic:claude-opus-5-5', allowedTools: new Set([FINDABILITY.tool]),
        toolLoopFn: (async (o: { toolHandlers: Map<string, { execute: (a: unknown) => Promise<unknown> }> }) => {
          rows = (await o.toolHandlers.get(`brain_${FINDABILITY.tool}`)!.execute({ query })) as Array<{ slug: string }>;
          return { messages: [{ role: 'assistant', content: 'done' }], totalUsage: {}, totalTurns: 1, stopReason: 'end' };
        }) as never,
      });
    } finally {
      Date.now = realNow;
    }
    return [...new Set(rows.map(r => r.slug))];
  };
  return { search, close: () => engine.disconnect() };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const pages = loadWorldV3(REV1_KNOBS).pages;
  if (cmd === 'write') {
    const queries = rev1ProbeQueries();
    const kept = (() => {
      if (arg === '--fresh') return new Map<string, string[]>();
      try { const c = loadFindabilityCache(pages); return c.header.gbrain_version === GBRAIN ? c.hits : new Map<string, string[]>(); } catch { return new Map<string, string[]>(); }
    })();
    const todo = queries.filter(q => !kept.has(q));
    const { search, close } = await openSearch(pages);
    const found = new Map<string, string[]>();
    for (const [i, q] of todo.entries()) {
      found.set(q, await search(q));
      if ((i + 1) % 500 === 0) console.log(`searched ${i + 1}/${todo.length}`);
    }
    await close();
    const lines = queries.map(q => JSON.stringify({ q, hits: found.get(q) ?? kept.get(q)! }));
    console.log(`${todo.length} searched, ${queries.length - todo.length} kept from the file`);
    const header: FindabilityHeader = { world_sha256: worldHash(pages), gbrain_version: GBRAIN, tool: FINDABILITY.tool, limit: FINDABILITY.limit, clock: FINDABILITY.clock, embeddings: 'off', queries: queries.length };
    writeFileSync(FINDABILITY_CACHE_PATH, [JSON.stringify(header), ...lines].join('\n') + '\n');
    console.log(`wrote ${FINDABILITY_CACHE_PATH}: ${queries.length} queries, world ${header.world_sha256.slice(0, 12)}`);
  } else if (cmd === 'check') {
    const { hits } = loadFindabilityCache(pages);
    const all = [...hits.keys()];
    const n = arg ? Math.min(Number(arg), all.length) : all.length;
    const sample = n === all.length ? all : new Rng(30_010).shuffle(all).slice(0, n);
    const { search, close } = await openSearch(pages);
    const diffs: string[] = [];
    for (const q of sample) { const h = await search(q); if (h.join() !== hits.get(q)!.join()) diffs.push(q); }
    await close();
    const missing = rev1ProbeQueries().filter(q => !hits.has(q));
    for (const q of [...diffs.slice(0, 20)]) console.log(`  ✗ differs: ${q}`);
    if (missing.length) console.log(`  ✗ ${missing.length} probe queries are not in the cache`);
    console.log(`${sample.length} re-searched, ${diffs.length} differ, ${missing.length} missing`);
    if (diffs.length || missing.length) process.exit(1);
  } else {
    console.error('usage: findability-v3.ts write|check [N]');
    process.exit(2);
  }
}

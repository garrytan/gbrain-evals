/**
 * Projects one tier's fictional graph into HydraDB over its HTTP API: every
 * vertex with label Page, then for every link type a forward T_<TYPE> and a
 * reversed R_<TYPE> relationship, plus catch-all LINK and LINK_R. Batches of
 * 1,000 (server cap 1,024); the edge batch deduplicates (src, dst, type), so a
 * retried batch is safe. Verifies each relationship's count afterwards with a
 * label-anchored count(*), or, with HYDRA_VERIFY=index (Company tier, where the
 * count scan takes hours), leaves it to run-tier.sh's wait for the indexer to
 * publish a generation with the expected edge count for every relationship.
 *
 * Usage: bun eval/runner/graph-backend/hydra-load.ts <tier>
 * Env: HYDRA_URL, HYDRA_TOKEN (defaults match run.ts), HYDRA_LOAD_CONCURRENCY.
 */
import { generate, LINK_TYPES, type Tier } from './generate.ts';
import { HydraClient, relFwd, relRev } from './hydra.ts';

const tier = process.argv[2] as Tier;
const hydra = new HydraClient({
  url: process.env.HYDRA_URL ?? 'http://127.0.0.1:8443', token: process.env.HYDRA_TOKEN ?? 'local-development-token-32-bytes-xx',
  graph: 'default', namespace: 'default', cell: 'cell-0', concurrency: Number(process.env.HYDRA_LOAD_CONCURRENCY ?? 8),
});
const g = generate(tier);
const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
};
const t0 = performance.now();
const nodeTasks: Array<() => Promise<unknown>> = [];
for (let lo = 1; lo <= g.pages; lo += 1000) {
  const rows = Array.from({ length: Math.min(1000, g.pages + 1 - lo) }, (_, i) => ({ id: lo + i }));
  nodeTasks.push(() => retry(() => hydra.query('UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Page', { rows })));
}
await hydra.pool(nodeTasks);
const tNodes = performance.now();
const rels: Array<{ rel: string; idx: number[]; reversed: boolean }> = [];
for (let ti = 0; ti < LINK_TYPES.length; ti++) {
  const idx: number[] = [];
  for (let i = 0; i < g.type.length; i++) if (g.type[i] === ti) idx.push(i);
  rels.push({ rel: relFwd(ti), idx, reversed: false }, { rel: relRev(ti), idx, reversed: true });
}
const all = Array.from({ length: g.from.length }, (_, i) => i);
rels.push({ rel: 'LINK', idx: all, reversed: false }, { rel: 'LINK_R', idx: all, reversed: true });
const relMs: Record<string, number> = {};
for (const { rel, idx, reversed } of rels) {
  const t = performance.now();
  const tasks: Array<() => Promise<unknown>> = [];
  for (let lo = 0; lo < idx.length; lo += 1000) {
    const rows = idx.slice(lo, lo + 1000).map(i => reversed ? { src: g.to[i], dst: g.from[i] } : { src: g.from[i], dst: g.to[i] });
    tasks.push(() => retry(() => hydra.query(`UNWIND $rows AS row CREATE (a {id: row.src})-[:${rel}]->(b {id: row.dst})`, { rows })));
  }
  await hydra.pool(tasks);
  relMs[rel] = Math.round(performance.now() - t);
  console.error(`[hydra-load] ${tier} ${rel} ${idx.length} edges in ${relMs[rel]} ms`);
}
const tEdges = performance.now();
const counts: Record<string, { expected: number; got: number | null }> = {};
const countVerify = process.env.HYDRA_VERIFY !== 'index';
for (const { rel, idx } of rels) {
  if (!countVerify) { counts[rel] = { expected: idx.length, got: null }; continue; }
  const rows = await retry(() => hydra.query(`MATCH (a:Page)-[:${rel}]->(b) RETURN count(*) AS n`));
  counts[rel] = { expected: idx.length, got: Number((rows[0][0] as { value: number }).value) };
}
const tVerify = performance.now();
const ok = Object.values(counts).every(c => c.got === null || c.expected === c.got);
console.log(JSON.stringify({ tier, edgeSha256: g.edgeSha256, ok, verify: countVerify ? 'count' : 'index', counts, requests: hydra.requests, ms: { nodes: Math.round(tNodes - t0), edges: Math.round(tEdges - tNodes), per_relationship: relMs, verify: Math.round(tVerify - tEdges), total: Math.round(tVerify - t0) } }));
if (!ok) process.exit(1);

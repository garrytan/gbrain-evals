// Cat 7 get_timeline at 1,000 pages: the Cat 7 corpus (generateSeedData(1000), putPage then addLink, as eval/runner/perf.ts
// builds it), the reads Cat 7 runs first (get_page, get_links, get_backlinks, the hub's backlinks), then 2,000 timed engine.getTimeline calls over the Cat 7 slug plan after 50 warmups. Prints the p50 in ms.
// GBRAIN_ROOT selects the gbrain checkout (default: the pinned dependency). Exit 1 when the p50 is above
// LIMIT_MS (default 0.075 ms, halfway between the 48ed5e8 and 109b992 medians measured on the Cat 7 VMs).
import { join, resolve } from 'node:path';
import { buildSlugPlan, generateSeedData } from '../../../../eval/runner/perf.ts';
const root = process.env.GBRAIN_ROOT ? resolve(process.env.GBRAIN_ROOT) : join(import.meta.dir, '../../../../node_modules/gbrain');
const { PGLiteEngine } = await import(join(root, 'src/core/pglite-engine.ts'));
const version = (await Bun.file(join(root, 'package.json')).json()).version;
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const { pages, links } = generateSeedData(1000);
for (const { slug, page } of pages) await engine.putPage(slug, page);
for (const l of links) { try { await engine.addLink(l.from, l.to, '', l.type); } catch { /* as perf.ts */ } }
const slugs = pages.map(p => p.slug);
const plan = buildSlugPlan(slugs, 42 * 1000 + 4, 50);
// The reads Cat 7 times before get_timeline, in its order and counts (warmups included).
for (const [op, n] of [[0, 55], [1, 55], [2, 55]] as const) {
  const p = buildSlugPlan(slugs, 42 * 1000 + op, 50);
  for (let i = 0; i < n; i++) await (op === 0 ? engine.getPage(p[i % 50]) : op === 1 ? engine.getLinks(p[i % 50]) : engine.getBacklinks(p[i % 50]));
}
for (let i = 0; i < 25; i++) await engine.getBacklinks('people/person-0');
for (let i = 0; i < 50; i++) await engine.getTimeline(plan[i % 50]);
const ms: number[] = [];
for (let i = 0; i < 2000; i++) { const t = performance.now(); await engine.getTimeline(plan[i % 50]); ms.push(performance.now() - t); }
ms.sort((a, b) => a - b);
const p50 = ms[1000]!; const limit = Number(process.env.LIMIT_MS ?? 0.075);
console.log(JSON.stringify({ gbrain_version: version, calls: ms.length, p50_ms: +p50.toFixed(4), p90_ms: +ms[1800]!.toFixed(4), limit_ms: limit }));
await engine.disconnect();
process.exit(p50 > limit ? 1 : 0);

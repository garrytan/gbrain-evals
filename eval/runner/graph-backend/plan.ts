/**
 * Writes a tier's call plan: start pages (seeded, 10% hubs), which of them are
 * hubs, the 22-call matrix per start page in seeded order, and the uncounted
 * calibration calls.
 *
 * Usage: bun eval/runner/graph-backend/plan.ts <tier> <out.json> [startCount]
 */
import { writeFileSync } from 'node:fs';
import { callsFor, generate, type Tier } from './generate.ts';

const [tier, outPath, count] = process.argv.slice(2) as [Tier, string, string?];
const g = generate(tier);
const hubSet = new Set(g.hubs);
let starts = g.starts;
if (count) {
  const n = Number(count);
  const h = starts.filter(s => hubSet.has(s)).slice(0, Math.round(n / 10));
  const r = starts.filter(s => !hubSet.has(s)).slice(0, n - h.length);
  const keep = new Set([...h, ...r]);
  starts = starts.filter(s => keep.has(s));
}
const plan = {
  tier, edgeSha256: g.edgeSha256, pages: g.pages, links: g.from.length,
  starts, hubs: [...starts, ...g.calibration].filter(s => hubSet.has(s)),
  calls: callsFor(starts), calibration: g.calibration, calibration_calls: callsFor(g.calibration, 7),
};
writeFileSync(outPath, JSON.stringify(plan));
console.log(JSON.stringify({ tier, starts: starts.length, hubs_in_starts: starts.filter(s => hubSet.has(s)).length, calls: plan.calls.length, calibration_calls: plan.calibration_calls.length }));

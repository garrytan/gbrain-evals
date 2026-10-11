/**
 * The E2 keyless gate's verdict (e2-keyless-gate.sh): from the readings of a keyless run, every structural check that
 * must hold before any paid call. Guard 1 holds on every deliver row; every candidate delivery stays within its
 * explicit budget and reports its packing (guard 3); every candidate context fits with zero cuts (guard 4); every live
 * call reads its packing back and equals the assembled delivery on the fresh list; every arm holds every question; the
 * E3 gate reads every benchmark. Latency (guard 9) and scores are not judged here: the stub answers every call.
 *
 *   bun eval/runner/budgeted-delivery/e2-gate-check.ts <readings.json> <e3.json>
 */
import { readFileSync } from 'node:fs';

type J = Record<string, any>;
export function gateProblems(r: J, e3: J): string[] {
  const out: string[] = [];
  const L = r['lme-s'];
  for (const [v, g] of Object.entries(L.guards as J)) {
    if (!g.g1_compatibility.pass) out.push(`lme-s guard 1 fails (${v})`);
    if (!g.g3_product_cap.pass) out.push(`lme-s guard 3 fails for ${v}: ${JSON.stringify(g.g3_product_cap)}`);
    if (!g.g4_reader_context.pass) out.push(`lme-s guard 4 fails for ${v}: ${JSON.stringify(g.g4_reader_context)}`);
  }
  for (const [b, d] of Object.entries(r.descriptive as J)) {
    if (!d.guard1.pass) out.push(`${b} guard 1 fails`);
    for (const [v, c] of Object.entries(d.cap as J)) if (!c.pass) out.push(`${b} guard 3 fails for ${v}`);
    for (const [v, c] of Object.entries(d.contexts as J)) if (!c.pass) out.push(`${b} guard 4 fails for ${v}`);
    for (const [p, s] of Object.entries(d.scores as J)) if (!s.n || s.incomplete) out.push(`${b} arm ${p} incomplete (${s.n} scored, ${s.incomplete} not)`);
  }
  for (const [p, s] of Object.entries(L.live.per_packing as J)) {
    if (!s.calls) out.push(`live: no calls for ${p}`);
    if (s.packing_reported_ok !== s.calls) out.push(`live: ${s.calls - s.packing_reported_ok} calls of ${p} did not read back or report their packing`);
    if (s.parity_fresh_equal !== s.calls) out.push(`live: ${s.calls - s.parity_fresh_equal} calls of ${p} differ from the assembled delivery on the fresh list`);
  }
  for (const [a, s] of Object.entries(L.arms as J)) if (!s.n || s.incomplete) out.push(`lme-s arm ${a} incomplete (${s.n} scored, ${s.incomplete} not)`);
  if (!L.frontier?.cap_only) out.push('the phase 2 arms produced no frontier reading');
  for (const k of ['lme-s-slice', 'locomo', 'beam-100k']) if (!e3.readings?.[k]?.recall_all_at_5) out.push(`E3 has no recall reading for ${k}`);
  return out;
}

if (import.meta.main) {
  const [readings, e3] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p, 'utf8')) as J);
  const problems = gateProblems(readings, e3);
  if (problems.length) { console.error(`[e2-gate] FAILED:\n- ${problems.join('\n- ')}`); process.exit(1); }
  console.error('[e2-gate] passed');
}

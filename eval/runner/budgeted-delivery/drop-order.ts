/**
 * The preregistered drop order for the budgeted delivery E1 (plan "E1 cost"):
 * near the cap, the LoCoMo pseudo-session arms go first, then
 * `query-auto-default` on LoCoMo, then the saved-facts probe. Steering arms
 * and matched controls are never dropped.
 *
 * `planReads` decides, before the optional reader steps start, which of them
 * still fit: it drops from the front of the drop order until the estimates of
 * what remains, plus a reserve, fit what the ledger has left. It never
 * reorders and never drops a protected step; when protected steps alone do
 * not fit, it refuses (the run stops instead of spending past the cap).
 *
 *   bun eval/runner/budgeted-delivery/drop-order.ts --remaining <usd> --plan <steps.json> [--reserve <usd>]
 */
import { readFileSync } from 'node:fs';

export interface Step { id: string; estimate_usd: number; protected: boolean }

/** Optional steps, in the order they are dropped. */
export const DROP_ORDER = ['locomo-pseudo-arms', 'locomo-query-auto-default', 'facts-probe'] as const;

export function planReads(steps: readonly Step[], remainingUsd: number, reserveUsd = 0): { run: Step[]; dropped: Step[]; needed_usd: number } {
  const protectedSteps = steps.filter(s => s.protected);
  const optional = DROP_ORDER.map(id => steps.find(s => s.id === id && !s.protected)).filter((s): s is Step => !!s);
  const unknown = steps.filter(s => !s.protected && !(DROP_ORDER as readonly string[]).includes(s.id));
  if (unknown.length) throw new Error(`optional steps outside the preregistered drop order: ${unknown.map(s => s.id).join(', ')}`);
  const sum = (xs: Step[]) => xs.reduce((n, s) => n + s.estimate_usd, 0);
  const base = sum(protectedSteps) + reserveUsd;
  if (base > remainingUsd) throw new Error(`protected steps need $${base.toFixed(2)} with the reserve; $${remainingUsd.toFixed(2)} remains. Stop: steering arms and matched controls are never dropped.`);
  const dropped: Step[] = [];
  let keep = [...optional];
  while (keep.length && base + sum(keep) > remainingUsd) dropped.push(keep.shift()!);
  const run = steps.filter(s => s.protected || keep.includes(s));
  return { run, dropped, needed_usd: base + sum(keep) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const steps = JSON.parse(readFileSync(one('--plan') ?? '', 'utf8')) as Step[];
  console.log(JSON.stringify(planReads(steps, Number(one('--remaining')), Number(one('--reserve') ?? 0)), null, 2));
}

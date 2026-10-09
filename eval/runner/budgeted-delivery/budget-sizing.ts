/**
 * Budget sizing for the budgeted delivery E1 (plan C0, "Budget sizing, per
 * benchmark and rendering, on the real hit list"), $0: it reads the sizing
 * counts a `gbrain-query` freeze cell recorded per question and grid budget
 * (`accounting.sizing`), never the delivered text.
 *
 *   B = floor_100(8000 / (r_max x 1.02))
 *
 * where r_max is the highest per-question ratio of a rendering's serialized
 * harness tokens to gbrain's `budget_used`, across every delivery read at that
 * budget: `native` reads the full list (query-auto); `pseudo` reads the full
 * list (query-auto-pseudo) and its first five hits (query-auto-l5-pseudo).
 * Starting at the grid's top, r_max is measured at the current B and the rule
 * applied until B stops moving (a two-value cycle takes the lower value). A value
 * between grid points (a coarse keyless grid) snaps down to the next grid budget.
 *
 * Verification at the chosen B: every serialized delivery fits the harness
 * budget unless gbrain itself delivered more than B (`auto`'s documented
 * overrun), which the reader arm's packer then cuts and counts. A context
 * that overflows while gbrain stayed within B fails the sizing.
 *
 *   bun eval/runner/budgeted-delivery/budget-sizing.ts --rows <freeze retrievals/rows.ndjson> [--rows ...] --benchmark <name> [--out <file.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const HARNESS_BUDGET = 8000;
export const MARGIN = 1.02;

export interface SizingPoint { budget: number; full: { budget_used: number | null; blocks: number; over_budget: boolean; native: number; pseudo: number }; prefix: { budget_used: number | null; blocks: number; over_budget: boolean; pseudo: number } }
export type Rendering = 'native' | 'pseudo';

/** Each (question, delivery) pair read at this rendering: serialized harness tokens and gbrain's budget_used at grid budget `b`. */
function samples(rows: SizingPoint[][], rendering: Rendering, b: number): Array<{ serialized: number; used: number; over: boolean }> {
  const out: Array<{ serialized: number; used: number; over: boolean }> = [];
  for (const grid of rows) {
    const g = grid.find(x => x.budget === b);
    if (!g) throw new Error(`grid budget ${b} missing for a question`);
    const add = (serialized: number, used: number | null, over: boolean) => { if (used !== null && used > 0) out.push({ serialized, used, over }); };
    if (rendering === 'native') add(g.full.native, g.full.budget_used, g.full.over_budget);
    else { add(g.full.pseudo, g.full.budget_used, g.full.over_budget); add(g.prefix.pseudo, g.prefix.budget_used, g.prefix.over_budget); }
  }
  return out;
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null; };

export function sizeBudget(rows: SizingPoint[][], rendering: Rendering, harnessBudget = HARNESS_BUDGET, margin = MARGIN) {
  if (!rows.length) throw new Error('no sizing rows');
  const grid = rows[0].map(g => g.budget).sort((a, b) => a - b);
  let b = grid[grid.length - 1];
  const steps: Array<{ budget: number; r_max: number; next: number }> = [];
  for (let i = 0; i < 20; i++) {
    const r = Math.max(...samples(rows, rendering, b).map(s => s.serialized / s.used));
    const next = Math.floor(harnessBudget / (r * margin) / 100) * 100;
    steps.push({ budget: b, r_max: r, next });
    if (next === b) break;
    if (steps.length >= 2 && steps[steps.length - 2].budget === next) { b = Math.min(b, next); break; }
    if (next < grid[0]) throw new Error(`sizing moved to ${next}, below the grid ${grid[0]}..${grid[grid.length - 1]}; widen the grid`);
    if (!grid.includes(next)) { b = Math.max(...grid.filter(g => g <= next)); steps.push({ budget: b, r_max: NaN, next: b }); break; }
    b = next;
  }
  const at = samples(rows, rendering, b);
  const ratios = at.map(s => s.serialized / s.used);
  const overflow = at.filter(s => s.serialized > harnessBudget);
  const ratioCaused = overflow.filter(s => s.used <= b);
  return {
    rendering, budget: b, steps, margin, harness_budget: harnessBudget, samples: at.length,
    ratio: { max: Math.max(...ratios), p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9), p99: quantile(ratios, 0.99), mean: ratios.reduce((x, y) => x + y, 0) / ratios.length },
    verification: { overflow: overflow.length, overflow_from_gbrain_overrun: overflow.length - ratioCaused.length, overflow_within_budget: ratioCaused.length, passed: ratioCaused.length === 0, gbrain_over_budget: at.filter(s => s.over).length },
  };
}

export function loadSizingRows(paths: string[]): SizingPoint[][] {
  const out: SizingPoint[][] = [];
  for (const p of paths) for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { outcome?: string; accounting?: { sizing?: SizingPoint[] } };
    if (row.accounting?.sizing?.length) out.push(row.accounting.sizing);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const many = (n: string) => argv.flatMap((a, i) => a === n ? [argv[i + 1]] : []);
  const one = (n: string) => many(n)[0];
  const rows = loadSizingRows(many('--rows'));
  const result = { benchmark: one('--benchmark') ?? null, questions: rows.length, native: sizeBudget(rows, 'native'), pseudo: sizeBudget(rows, 'pseudo') };
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
}

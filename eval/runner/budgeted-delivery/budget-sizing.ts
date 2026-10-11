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
 *   bun eval/runner/budgeted-delivery/budget-sizing.ts --rows <freeze retrievals/rows.ndjson> [--rows ...] --benchmark <name> [--out <file.json>] [--e2]
 *
 * `--e2` reads the E2 freeze cells' `accounting.sizing_e2` instead (preregistration
 * docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md) and sizes three budgets with the same
 * rule, each across every delivery read at it (`E2_BUDGETS`): `b_pseudo` and `b_native` on the 8,000-token grid,
 * `b16_pseudo` on the 16,000-token grid against a 16,000-token harness budget.
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

/** E2: a question's sizing counts per grid budget and sizing variant (system.ts E2_SIZING). */
export interface SizingE2Point { grid: 'b8' | 'b16'; budget: number; variants: Record<string, { budget_used: number | null; blocks: number; over_budget: boolean; pseudo: number; native?: number }> }

/** Each E2 budget: its grid, the rendering read at it, the deliveries read at it and the harness budget. */
export const E2_BUDGETS = {
  b_pseudo: { grid: 'b8', rendering: 'pseudo', variants: ['off', 'cap_only', 'breadth_capped', 'depth_first', 'off-l5', 'window'], harness: 8000 },
  b_native: { grid: 'b8', rendering: 'native', variants: ['off', 'cap_only', 'breadth_capped', 'depth_first'], harness: 8000 },
  b16_pseudo: { grid: 'b16', rendering: 'pseudo', variants: ['off', 'cap_only', 'breadth_capped', 'depth_first'], harness: 16000 },
  /** LoCoMo and BEAM read `b_pseudo` through the four packings alone (`size_set=primary`). */
  b_pseudo_primary: { grid: 'b8', rendering: 'pseudo', variants: ['off', 'cap_only', 'breadth_capped', 'depth_first'], harness: 8000 },
} as const satisfies Record<string, { grid: 'b8' | 'b16'; rendering: Rendering; variants: readonly string[]; harness: number }>;

/** The E2 rows of one budget in the E1 shape the sizing loop reads: per question, per grid budget, the samples of every variant read at it. */
function e2Samples(rows: SizingE2Point[][], spec: (typeof E2_BUDGETS)[keyof typeof E2_BUDGETS]) {
  return (b: number) => {
    const out: Array<{ serialized: number; used: number; over: boolean }> = [];
    for (const grid of rows) {
      const g = grid.find(x => x.grid === spec.grid && x.budget === b);
      if (!g) throw new Error(`grid ${spec.grid} budget ${b} missing for a question`);
      for (const v of spec.variants) {
        const d = g.variants[v];
        if (!d) throw new Error(`grid ${spec.grid} budget ${b}: variant ${v} missing for a question`);
        const serialized = spec.rendering === 'native' ? d.native : d.pseudo;
        if (typeof serialized !== 'number') throw new Error(`grid ${spec.grid} budget ${b}: variant ${v} has no ${spec.rendering} count`);
        if (d.budget_used !== null && d.budget_used > 0) out.push({ serialized, used: d.budget_used, over: d.over_budget });
      }
    }
    return out;
  };
}

/** Size one E2 budget (same rule and verification as `sizeBudget`). */
export function sizeBudgetE2(rows: SizingE2Point[][], name: keyof typeof E2_BUDGETS, margin = MARGIN) {
  const spec = E2_BUDGETS[name];
  if (!rows.length) throw new Error('no sizing rows');
  const grid = [...new Set(rows[0].filter(g => g.grid === spec.grid).map(g => g.budget))].sort((a, b) => a - b);
  if (!grid.length) throw new Error(`no ${spec.grid} grid in the sizing rows`);
  return { name, grid: spec.grid, variants: spec.variants, ...sizeLoop(grid, e2Samples(rows, spec), spec.rendering, spec.harness, margin) };
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null; };

export function sizeBudget(rows: SizingPoint[][], rendering: Rendering, harnessBudget = HARNESS_BUDGET, margin = MARGIN) {
  if (!rows.length) throw new Error('no sizing rows');
  return sizeLoop(rows[0].map(g => g.budget).sort((a, b) => a - b), b => samples(rows, rendering, b), rendering, harnessBudget, margin);
}

/** The sizing iteration and its verification over any sample source (E1 and E2 share it). */
function sizeLoop(grid: number[], sampleAt: (b: number) => Array<{ serialized: number; used: number; over: boolean }>, rendering: Rendering, harnessBudget: number, margin: number) {
  let b = grid[grid.length - 1];
  const steps: Array<{ budget: number; r_max: number; next: number }> = [];
  for (let i = 0; i < 20; i++) {
    const r = Math.max(...sampleAt(b).map(s => s.serialized / s.used));
    const next = Math.floor(harnessBudget / (r * margin) / 100) * 100;
    steps.push({ budget: b, r_max: r, next });
    if (next === b) break;
    if (steps.length >= 2 && steps[steps.length - 2].budget === next) { b = Math.min(b, next); break; }
    if (next < grid[0] || next > grid[grid.length - 1]) throw new Error(`sizing moved to ${next}, outside the grid ${grid[0]}..${grid[grid.length - 1]}; widen the grid`);
    if (!grid.includes(next)) { b = Math.max(...grid.filter(g => g <= next)); steps.push({ budget: b, r_max: NaN, next: b }); break; }
    b = next;
  }
  const at = sampleAt(b);
  const ratios = at.map(s => s.serialized / s.used);
  const overflow = at.filter(s => s.serialized > harnessBudget);
  const ratioCaused = overflow.filter(s => s.used <= b);
  return {
    rendering, budget: b, steps, margin, harness_budget: harnessBudget, samples: at.length,
    ratio: { max: Math.max(...ratios), p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9), p99: quantile(ratios, 0.99), mean: ratios.reduce((x, y) => x + y, 0) / ratios.length },
    verification: { overflow: overflow.length, overflow_from_gbrain_overrun: overflow.length - ratioCaused.length, overflow_within_budget: ratioCaused.length, passed: ratioCaused.length === 0, gbrain_over_budget: at.filter(s => s.over).length },
  };
}

export function loadSizingRowsE2(paths: string[]): SizingE2Point[][] {
  const out: SizingE2Point[][] = [];
  for (const p of paths) for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { accounting?: { sizing_e2?: SizingE2Point[] } };
    if (row.accounting?.sizing_e2?.length) out.push(row.accounting.sizing_e2);
  }
  return out;
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
  /** Every value after each `n` up to the next flag, so a shell glob (--rows followed by several shard files) passes every file. */
  const many = (n: string) => argv.flatMap((a, i) => { if (a !== n) return []; const end = argv.findIndex((x, j) => j > i && x.startsWith('--')); return argv.slice(i + 1, end < 0 ? undefined : end); });
  const one = (n: string) => many(n)[0];
  let result: Record<string, unknown>;
  if (argv.includes('--e2')) {
    const rows = loadSizingRowsE2(many('--rows'));
    const names = (one('--budgets') ?? Object.keys(E2_BUDGETS).join(',')).split(',') as Array<keyof typeof E2_BUDGETS>;
    result = { benchmark: one('--benchmark') ?? null, questions: rows.length, ...Object.fromEntries(names.map(n => [n, sizeBudgetE2(rows, n)])) };
  } else {
    const rows = loadSizingRows(many('--rows'));
    result = { benchmark: one('--benchmark') ?? null, questions: rows.length, native: sizeBudget(rows, 'native'), pseudo: sizeBudget(rows, 'pseudo') };
  }
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
}

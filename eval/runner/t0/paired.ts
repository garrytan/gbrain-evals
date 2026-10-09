/**
 * T0b candidate comparison: each candidate cell paired with the frozen baseline cell of the same task, reader and
 * repeat, scored with PW's frozen statistics (power/risk-ratio.ts `decide`, conditional-binomial, 95%, loss
 * tolerance 3.0 points, persona clusters). Per reader first, then pooled.
 *
 *   bun eval/runner/t0/paired.ts --baseline <results.jsonl[.gz]> --candidate <results.jsonl[.gz]> [--repeats 1,2] [--out paired.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { clusteredRate, decide, type ClusterTotals } from '../power/risk-ratio.ts';
import { COUNTED_READERS } from '../t0-program-primary.ts';

interface Cell { task: string; persona: string; reader: string; arm: string; repeat: number; score: { failed: boolean; kinds: string[] } }

const LOSS_TOLERANCE = 0.03;

export function readJsonl(path: string): Cell[] {
  const raw = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString().split('\n').filter(Boolean).map(l => JSON.parse(l) as Cell);
}

export function compare(baseline: Cell[], candidate: Cell[], repeats: number[], readers: readonly string[] = COUNTED_READERS) {
  const key = (c: Cell) => `${c.task}|${c.reader}|${c.repeat}`;
  const base = new Map(baseline.filter(c => c.arm === 'baseline').map(c => [key(c), c]));
  const scopes: Array<[string, readonly string[]]> = [...readers.map((r): [string, readonly string[]] => [r, [r]]), ['pooled', readers]];
  return scopes.map(([label, scope]) => {
    const personas = new Map<string, ClusterTotals>();
    const kinds = { baseline: {} as Record<string, number>, candidate: {} as Record<string, number> };
    for (const c of candidate) {
      if (c.arm !== 'baseline' || !scope.includes(c.reader) || !repeats.includes(c.repeat)) continue;
      const b = base.get(key(c));
      if (!b) continue;
      const x = personas.get(c.persona) ?? { n: 0, baseline: 0, candidate: 0 };
      x.n++; x.baseline += b.score.failed ? 1 : 0; x.candidate += c.score.failed ? 1 : 0;
      personas.set(c.persona, x);
      for (const k of b.score.kinds) kinds.baseline[k] = (kinds.baseline[k] ?? 0) + 1;
      for (const k of c.score.kinds) kinds.candidate[k] = (kinds.candidate[k] ?? 0) + 1;
    }
    const totals = [...personas.values()];
    const d = decide(totals, 'cond-binomial', { lossTolerance: LOSS_TOLERANCE });
    return {
      scope: label, pairs: totals.reduce((s, x) => s + x.n, 0), personas: totals.length,
      baseline: { failures: totals.reduce((s, x) => s + x.baseline, 0), clustered: clusteredRate(totals.map(x => ({ n: x.n, failures: x.baseline }))) },
      candidate: { failures: totals.reduce((s, x) => s + x.candidate, 0), clustered: clusteredRate(totals.map(x => ({ n: x.n, failures: x.candidate }))) },
      verdict: d.verdict, ratio: d.estimate, risk_difference: d.risk_difference, non_inferior: d.non_inferior, kinds,
    };
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const b = flag('--baseline'), c = flag('--candidate');
  if (!b || !c) throw new Error('--baseline <results.jsonl[.gz]> and --candidate <results.jsonl[.gz]> are required');
  const rows = compare(readJsonl(b), readJsonl(c), (flag('--repeats') ?? '1,2').split(',').map(Number));
  if (flag('--out')) writeFileSync(flag('--out')!, JSON.stringify(rows, null, 1) + '\n');
  for (const r of rows) console.log(`${r.scope.padEnd(18)} pairs ${r.pairs}  baseline ${r.baseline.failures}  candidate ${r.candidate.failures}  ${r.verdict}${r.ratio ? `  R ${r.ratio.ratio.toFixed(3)} [${r.ratio.lower.toFixed(3)}, ${r.ratio.upper.toFixed(3)}]  factor ${r.ratio.factor.toFixed(2)}` : ''}  risk diff ${(100 * r.risk_difference.diff).toFixed(1)} pts [${(100 * r.risk_difference.lower).toFixed(1)}, ${(100 * r.risk_difference.upper).toFixed(1)}]`);
}

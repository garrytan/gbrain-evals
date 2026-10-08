/**
 * T0 analysis: failure counts per arm and reader with clustered intervals,
 * mutant detection against the baseline, the resource envelope, and the
 * capture diagnostics, from one or more results.jsonl files.
 *
 *   bun eval/runner/t0/analyze.ts <results.jsonl> [more.jsonl ...] [--out summary.json]
 *
 * Mutant detection (frozen in the preregistration). Paired with the baseline
 * cells of the same reader, task and repeat:
 *   - with two or more personas: the clustered risk difference (mutant minus
 *     baseline failure rate, t on personas - 1 df) has a 95% lower bound
 *     above 0, and for the stale-correction mutant the stale_correction kind
 *     is more frequent than in the baseline;
 *   - with one persona (the hermetic slice): every pair where the baseline
 *     passed fails under the mutant (exact, scripted reader).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { CellRecord } from '../t0-program-primary.ts';
import { clusteredRate, riskDifference } from '../power/risk-ratio.ts';
import { aggregate, FAILURE_KINDS } from './score.ts';

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function readCells(paths: readonly string[]): CellRecord[] {
  const byKey = new Map<string, CellRecord>();
  for (const p of paths) for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as CellRecord; byKey.set(r.key, r); }
  return [...byKey.values()];
}

export function summarize(cells: readonly CellRecord[]) {
  const groups = new Map<string, CellRecord[]>();
  for (const c of cells) { const k = `${c.arm}|${c.reader}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
  const rows = [...groups.entries()].sort().map(([k, cs]) => {
    const [arm, reader] = k.split('|');
    const byPersona = new Map<string, { n: number; failures: number }>();
    for (const c of cs) { const x = byPersona.get(c.persona) ?? { n: 0, failures: 0 }; x.n++; if (c.score.failed) x.failures++; byPersona.set(c.persona, x); }
    const agg = aggregate(cs.map(c => c.score));
    const s2 = cs.map(c => c.sessions[1]?.wall_ms ?? 0);
    return {
      arm, reader, ...agg, clustered: clusteredRate([...byPersona.values()]),
      by_task_kind: Object.fromEntries(['prep', 'reply'].map(kind => { const sub = cs.filter(c => c.kind === kind); return [kind, { runs: sub.length, failures: sub.filter(c => c.score.failed).length }]; })),
      by_correction_kind: Object.fromEntries(['role', 'seats', 'price'].map(kind => { const sub = cs.filter(c => c.correction_kind === kind); return [kind, { runs: sub.length, failures: sub.filter(c => c.score.failed).length }]; })),
      omissions: { date: cs.filter(c => c.score.omissions.date).length, correction: cs.filter(c => c.score.omissions.correction).length },
      capture: { any_write: cs.filter(c => c.capture.writes > 0).length, commitment: cs.filter(c => c.capture.commitment).length, new_date: cs.filter(c => c.capture.new_date).length, corrected: cs.filter(c => c.capture.corrected).length },
      push: { s2_user_prompt_ok: cs.filter(c => c.sessions[1]?.hooks.find(h => h.event === 'user-prompt')?.outcome === 'ok').length, s2_session_start_ok: cs.filter(c => c.sessions[1]?.hooks.find(h => h.event === 'session-start')?.outcome === 'ok').length },
      envelope: {
        cell_wall_ms: { p50: pct(cs.map(c => c.wall_ms), 0.5), p95: pct(cs.map(c => c.wall_ms), 0.95) },
        session2_wall_ms: { p50: pct(s2, 0.5), p95: pct(s2, 0.95) },
        tokens_per_cell: { input_mean: mean(cs.map(c => c.tokens.input_total)), output_mean: mean(cs.map(c => c.tokens.output_total)) },
        usd_per_cell: { reader_mean: mean(cs.map(c => c.usd.reader)), gbrain_internal_mean: mean(cs.map(c => c.usd.gbrain_internal)), total_mean: mean(cs.map(c => c.usd.total)), total_sum: cs.reduce((s, c) => s + c.usd.total, 0) },
      },
    };
  });

  const baseline = new Map(cells.filter(c => c.arm === 'baseline').map(c => [`${c.task}|${c.reader}|${c.repeat}`, c]));
  const mutants = ['mutant-forced-drop', 'mutant-stale-correction', 'ablation-push-off'].flatMap(arm => {
    const readers = [...new Set(cells.filter(c => c.arm === arm).map(c => c.reader))];
    return readers.map(reader => {
      const pairs = cells.filter(c => c.arm === arm && c.reader === reader).map(m => ({ m, b: baseline.get(`${m.task}|${m.reader}|${m.repeat}`) })).filter((p): p is { m: CellRecord; b: CellRecord } => !!p.b);
      const personas = new Map<string, { n: number; baseline: number; candidate: number }>();
      for (const { m, b } of pairs) { const x = personas.get(m.persona) ?? { n: 0, baseline: 0, candidate: 0 }; x.n++; x.baseline += b.score.failed ? 1 : 0; x.candidate += m.score.failed ? 1 : 0; personas.set(m.persona, x); }
      const totals = [...personas.values()];
      const rd = riskDifference(totals);
      const staleM = pairs.filter(p => p.m.score.kinds.includes('stale_correction')).length;
      const staleB = pairs.filter(p => p.b.score.kinds.includes('stale_correction')).length;
      const exact = pairs.filter(p => !p.b.score.failed).every(p => p.m.score.failed) && pairs.some(p => !p.b.score.failed);
      const detected = totals.length >= 2 ? rd.lower > 0 && (arm !== 'mutant-stale-correction' || staleM > staleB) : exact && (arm !== 'mutant-stale-correction' || staleM > staleB);
      return { arm, reader, pairs: pairs.length, personas: totals.length, mutant_failures: totals.reduce((s, x) => s + x.candidate, 0), baseline_failures: totals.reduce((s, x) => s + x.baseline, 0), risk_difference: rd, stale_correction: { mutant: staleM, baseline: staleB }, rule: totals.length >= 2 ? 'clustered risk difference lower bound > 0' : 'exact: every baseline pass fails under the mutant', detected };
    });
  });
  return { failure_kinds: FAILURE_KINDS, rows, mutants, cells: cells.length };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--out');
  const out = oi >= 0 ? argv[oi + 1] : null;
  const s = summarize(readCells(argv.filter(a => a.endsWith('.jsonl'))));
  if (out) writeFileSync(out, JSON.stringify(s, null, 1) + '\n');
  for (const r of s.rows) console.log(`${r.arm.padEnd(24)} ${r.reader.padEnd(18)} failures ${r.failures}/${r.runs} (${(100 * r.failure_rate).toFixed(1)}%, 95% CI ${(100 * r.clustered.lower).toFixed(1)}-${(100 * r.clustered.upper).toFixed(1)}) complete ${r.complete} kinds ${JSON.stringify(Object.fromEntries(Object.entries(r.by_kind).filter(([, v]) => v)))} $${r.envelope.usd_per_cell.total_sum.toFixed(2)}`);
  for (const m of s.mutants) console.log(`${m.arm} (${m.reader}): ${m.mutant_failures}/${m.pairs} vs baseline ${m.baseline_failures}/${m.pairs}; ${m.detected ? 'DETECTED' : 'not detected'} (${m.rule})`);
}

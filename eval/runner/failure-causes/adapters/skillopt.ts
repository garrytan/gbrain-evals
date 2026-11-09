/**
 * SkillOpt proposer inputs (docs/benchmarks/2026-11-01-skillopt-method/probe/
 * frontier/<stage>/one-shot/*-input.txt), which list every tool call of the
 * training rollouts as "- <tool> <args> returned <outcome>". These are call
 * counts on a harness path, so the adapter returns stress counts, never rows.
 */
import { fileText, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { StressCount } from '../types.ts';
import { emptyCounts, type AdapterOutput } from './shared.ts';

const CALL = /^- ([a-z_]+) (\{.*\}) returned (.+)$/;

export function fromSkillOpt(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  if (!entry.model) throw new Error(`${entry.id}: a skillopt source names its model`);
  const byTool = new Map<string, { calls: number; errors: number; empty: Map<string, number>; files: Set<string> }>();
  for (const f of files.filter(x => x.role === 'proposer_input')) {
    for (const line of fileText(f).split('\n')) {
      const m = CALL.exec(line);
      if (!m) continue;
      counts.read++;
      counts.mapped++;
      const t = byTool.get(m[1]) ?? { calls: 0, errors: 0, empty: new Map(), files: new Set() };
      byTool.set(m[1], t);
      t.calls++;
      if (m[3].trim() !== 'an error') continue;
      t.errors++;
      counts.failed++;
      t.files.add(pointer(f));
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(m[2]); } catch { /* an unparseable argument list still counts as a failed call */ }
      for (const [k, v] of Object.entries(args)) if (v === '' || (Array.isArray(v) && v.length === 0)) t.empty.set(k, (t.empty.get(k) ?? 0) + 1);
    }
  }
  const stress: StressCount[] = [...byTool].filter(([, t]) => t.errors > 0).map(([tool, t]) => ({
    source: entry.id, run_id: entry.id, system: 'gbrain', model: entry.model!, gbrain_sha: entry.gbrain_sha ?? null,
    condition: entry.condition, visibility: entry.visibility, cause: 'tool_contract', unit: 'calls', count: t.errors, of: t.calls,
    detail: `${tool}: ${t.errors} of ${t.calls} calls returned an error; empty optional arguments on failed calls: ${[...t.empty].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    evidence: [...t.files],
  }));
  return { failures: [], stress, counts };
}

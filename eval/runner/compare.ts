/**
 * Paired comparison of two runs: bun eval/runner/compare.ts <A> <B> [flags]
 *
 * A is the baseline and B the candidate. Each file holds one JSON row per
 * item (NDJSON), a JSON array, or a JSON document with --rows-path.
 *
 *   --family <file>        preregistered family (eval/runner/stats/gates.ts);
 *                          decides pass / fail / inconclusive / blocked
 *   --metric <field>       metric to compare (repeatable); without --family
 *                          every metric is exploratory and nothing gates
 *   --cluster-by <path>    cluster id for --metric comparisons (default: the id)
 *   --id <field>           item id field (default: question_id, else id)
 *   --exclude-when <k=v>   ineligible on both sides when it matches (repeatable)
 *   --where <k=v>          keep rows matching on both sides (repeatable)
 *   --a-where / --b-where  side-specific row filters (repeatable)
 *   --rows-path <path>     array inside a JSON document (both sides);
 *   --a-rows-path / --b-rows-path  side-specific
 *   --seed <n> --draws <n> --alpha <x>   (defaults 42, 10000, 0.05)
 *   --json                 machine-readable decision
 *
 * Exit status: 0 pass or report-only, 1 fail, 2 inconclusive or blocked.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluateFamily, loadFamily, validateFamily, type ComparisonFamily, type ComparisonResult, type FamilyDecision } from './stats/gates.ts';
import { loadRows, selectRows, parseRule } from './stats/rows.ts';

export interface CompareArgs {
  a: string;
  b: string;
  family?: string;
  metrics: string[];
  clusterBy?: string;
  id?: string;
  excludeWhen: string[];
  where: string[];
  aWhere: string[];
  bWhere: string[];
  aRowsPath?: string;
  bRowsPath?: string;
  seed: number;
  draws: number;
  alpha: number;
  json: boolean;
}

export function parseCompareArgs(argv: string[]): CompareArgs {
  const positional: string[] = [];
  const out: CompareArgs = { a: '', b: '', metrics: [], excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 42, draws: 10000, alpha: 0.05, json: false };
  const single = new Set<string>();
  const value = (flag: string, i: number) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const once = (flag: string) => { if (single.has(flag)) throw new Error(`${flag} given twice`); single.add(flag); };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) { positional.push(flag); continue; }
    if (flag === '--json') { out.json = true; continue; }
    const v = value(flag, i++);
    switch (flag) {
      case '--family': once(flag); out.family = v; break;
      case '--metric': out.metrics.push(v); break;
      case '--cluster-by': once(flag); out.clusterBy = v; break;
      case '--id': once(flag); out.id = v; break;
      case '--exclude-when': parseRule(v); out.excludeWhen.push(v); break;
      case '--where': parseRule(v); out.where.push(v); break;
      case '--a-where': parseRule(v); out.aWhere.push(v); break;
      case '--b-where': parseRule(v); out.bWhere.push(v); break;
      case '--rows-path': once(flag); out.aRowsPath ??= v; out.bRowsPath ??= v; break;
      case '--a-rows-path': once(flag); out.aRowsPath = v; break;
      case '--b-rows-path': once(flag); out.bRowsPath = v; break;
      case '--seed': once(flag); out.seed = Number(v); if (!Number.isSafeInteger(out.seed)) throw new Error('--seed must be an integer'); break;
      case '--draws': once(flag); out.draws = Number(v); if (!Number.isSafeInteger(out.draws) || out.draws < 1000) throw new Error('--draws must be an integer >= 1000'); break;
      case '--alpha': once(flag); out.alpha = Number(v); if (!(out.alpha > 0 && out.alpha < 0.5)) throw new Error('--alpha must be in (0, 0.5)'); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (positional.length !== 2) throw new Error('usage: bun eval/runner/compare.ts <A> <B> (--family <file> | --metric <field>) [flags]');
  [out.a, out.b] = positional;
  if (!out.family && !out.metrics.length) throw new Error('give --family <file> or at least one --metric');
  if (new Set(out.metrics).size !== out.metrics.length) throw new Error('duplicate --metric');
  return out;
}

export interface CompareOutput {
  inputs: Array<{ side: 'A' | 'B'; path: string; sha256: string; rows: number; skipped_summary_rows: number }>;
  family: ComparisonFamily;
  preregistered: boolean;
  decision: FamilyDecision;
}

export function runCompare(args: CompareArgs): CompareOutput {
  const preregistered = Boolean(args.family);
  const base = args.family ? loadFamily(args.family) : undefined;
  const probe = loadRows(args.a, { idField: args.id ?? base?.id_field ?? 'question_id', rowsPath: args.aRowsPath });
  const idField = args.id ?? base?.id_field ?? (probe.rows.some(r => r.question_id !== undefined) ? 'question_id' : 'id');
  if (base && args.id && args.id !== base.id_field) throw new Error(`--id ${args.id} conflicts with the family's id_field ${base.id_field}`);
  const load = (side: 'A' | 'B') => {
    const path = side === 'A' ? args.a : args.b;
    const loaded = loadRows(path, { idField, rowsPath: side === 'A' ? args.aRowsPath : args.bRowsPath });
    const rows = selectRows(loaded.rows, [...args.where, ...(side === 'A' ? args.aWhere : args.bWhere)]);
    return { rows, info: { side, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), rows: rows.length, skipped_summary_rows: loaded.skipped_summary_rows } };
  };
  const a = load('A'), b = load('B');
  const known = new Set(base?.comparisons.map(c => c.metric) ?? []);
  const adhoc = args.metrics.filter(m => !known.has(m)).map(metric => ({
    id: preregistered ? `adhoc:${metric}` : metric, metric, gate: 'exploratory' as const,
    ...(args.clusterBy ? { cluster_by: args.clusterBy } : {}),
    description: preregistered ? 'requested on the command line, outside the preregistered family' : 'ad hoc',
  }));
  const family = validateFamily(base
    ? { ...base, exclude_when: [...(base.exclude_when ?? []), ...args.excludeWhen], comparisons: [...base.comparisons, ...adhoc] }
    : { schema_version: 1, family_id: 'ad-hoc (not preregistered)', registered_at: new Date().toISOString(), alpha: args.alpha, seed: args.seed, draws: args.draws,
        id_field: idField, ...(args.excludeWhen.length ? { exclude_when: args.excludeWhen } : {}), comparisons: adhoc });
  return { inputs: [a.info, b.info], family, preregistered, decision: evaluateFamily(a.rows, b.rows, family) };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)} pp`;
const num = (x: number) => Math.abs(x) <= 1 ? pct(x) : x.toFixed(4);

function describe(r: ComparisonResult): string[] {
  const lines = [`- ${r.id} [${r.gate}] ${r.status.toUpperCase()}${r.metric !== r.id ? ` (metric ${r.metric})` : ''}`];
  if (r.stats) {
    const s = r.stats;
    lines.push(`    A ${s.mean_a.toFixed(4)}  B ${s.mean_b.toFixed(4)}  delta ${num(s.delta)}  95% CI ${s.ci95 ? `[${num(s.ci95[0])}, ${num(s.ci95[1])}]` : 'n/a'}  over ${s.n_pairs} pairs in ${s.n_clusters} clusters${r.n_excluded ? `, ${r.n_excluded} ineligible on both sides` : ''}`);
    lines.push(`    sign-flip p (two-sided) ${s.p_two_sided.toPrecision(3)} (${s.p_method})${r.gate === 'exploratory' ? ', unadjusted' : ''}`);
  }
  if (r.mcnemar) lines.push(`    exact McNemar: B wins ${r.mcnemar.wins}, B losses ${r.mcnemar.losses}, p = ${r.mcnemar.p_two_sided.toPrecision(3)}`);
  if (r.p_holm !== undefined) lines.push(`    non-inferiority (tolerance ${r.tolerance}, ${r.direction} is better): p ${r.p_noninferiority === null ? 'n/a' : r.p_noninferiority!.toPrecision(3)}, Holm p ${r.p_holm.toPrecision(3)}`);
  if (r.power) lines.push(`    power: ${r.power.note}`);
  for (const reason of r.reasons.slice(0, 6)) lines.push(`    note: ${reason}`);
  if (r.violations?.length) lines.push(`    violations: ${r.violations.slice(0, 10).join(', ')}${r.violations.length > 10 ? ', ...' : ''}`);
  return lines;
}

export function formatCompare(out: CompareOutput): string {
  const d = out.decision;
  const lines = [
    `Paired comparison: A = ${out.inputs[0].path} (${out.inputs[0].rows} rows), B = ${out.inputs[1].path} (${out.inputs[1].rows} rows)`,
    `Family: ${d.family_id}${out.preregistered ? ` (registered ${out.family.registered_at})` : ''}; alpha ${d.alpha}; Holm over ${d.holm_family.length ? d.holm_family.join(', ') : 'no confirmatory tests'}`,
    `Verdict: ${d.verdict.toUpperCase()}${d.reasons.length ? ` (${d.reasons.join('; ')})` : ''}`,
    '',
    ...d.comparisons.flatMap(describe),
  ];
  if (!out.preregistered) lines.push('', 'No preregistered family was given, so every comparison is exploratory and nothing gates.');
  return lines.join('\n');
}

export function exitCode(decision: FamilyDecision): number {
  return decision.verdict === 'pass' || decision.verdict === 'report_only' ? 0 : decision.verdict === 'fail' ? 1 : 2;
}

if (import.meta.main) {
  try {
    const args = parseCompareArgs(process.argv.slice(2));
    const out = runCompare(args);
    console.log(args.json ? JSON.stringify(out, null, 2) : formatCompare(out));
    process.exitCode = exitCode(out.decision);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

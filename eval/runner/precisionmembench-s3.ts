/**
 * Secondary family S3 of the open-source memory shootout: PrecisionMemBench on
 * the upstream contract (preregistration, "Secondary families").
 *
 *   bun eval/runner/precisionmembench-s3.ts --master <run dir> [--pin <run dir>] --system <run dir>... --output <dir>
 *
 * Each run directory is one `precisionmembench-system.ts` output (receipt.json
 * and rows.ndjson). `--master` is gbrain-shootout common at frozen master, the
 * baseline of the preregistered family (amendment A2); `--pin` is
 * gbrain-shootout common at the repository pin, computed the same way as a
 * second, descriptive family. `--system` names each vendor's common run.
 *
 * Per baseline, each system is paired with gbrain on the 43 search-only cases
 * (every category outside the vendored scorer's STRUCTURAL_CATEGORIES), once
 * for precision and once for recall: `pairObservations` with the case as its
 * own cluster, `clusteredPairedDelta` (seed 20261006, 10,000 draws), delta =
 * system minus gbrain, the two-sided cluster sign-flip p-value, then
 * `holmAdjusted` across the family's comparisons. With 43 clusters the
 * sign-flip test is Monte Carlo, so the smallest p-value is 1/10,001.
 *
 * Which cases enter a pair:
 *   - as in the primary family (`crossSystemExclusion`): a case that is a
 *     harness failure (`harness_invalid`, `budget_not_run`) or has no row on
 *     any run in the family (the baseline and every measurable system) is
 *     excluded from every pair of that family, and counted;
 *   - product failures stay in, as the misses the runner scored them as;
 *   - following the upstream scorer, a case whose metric is undefined on
 *     either side (recall when nothing is expected, precision when nothing is
 *     expected and nothing was returned, or a retrieval whose items cite no
 *     source) is dropped from that metric's pair and counted per side.
 * A system whose returned items all lack provenance is "not measurable": its
 * comparisons are reported as such and leave the Holm family. As in the
 * primary family, a pair with more than 5% of the search-only cases excluded
 * (3 or more of 43), or with a run that is invalid or incomplete, keeps its
 * numbers and its place in the Holm family but reads "incomplete", with no
 * direction.
 *
 * Beside every precision: the system's share of returned items that cite no
 * source, which precision cannot see. Structural categories are summarized
 * per system with no tests.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crossSystemExclusion, HARNESS_FAILURES } from './memory-qa/outcomes.ts';
import { clusteredPairedDelta, holmAdjusted, pairObservations, powerNote, type Observation, type PowerNote } from './stats/paired.ts';
import { CONTRACT, familyOf, provenanceBlind, type PmbRow } from './precisionmembench-system.ts';

export const S3_SEED = 20261006;
export const S3_DRAWS = 10_000;
export const S3_ALPHA = 0.05;
export const SEARCH_ONLY_CASES = 43;
const INCOMPLETE_SHARE = 0.05;
export const METRICS = ['precision', 'recall'] as const;
export type Metric = (typeof METRICS)[number];

export interface PmbRun {
  dir: string;
  name: string;
  config: string;
  build: string | null;
  run_status: string;
  fixture_sha256: Record<string, string>;
  scorer_sha256: Record<string, string>;
  rows: PmbRow[];
}

/** One run directory as the analysis reads it. */
export function loadRun(dir: string): PmbRun {
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as Record<string, any>;
  if (receipt.kind !== 'precisionmembench-system' || receipt.contract !== CONTRACT) throw new Error(`${dir}: not a precisionmembench-system receipt on the ${CONTRACT}`);
  const rows = readFileSync(join(dir, 'rows.ndjson'), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as PmbRow);
  const identity = receipt.system?.identity ?? {};
  const config = typeof identity.config === 'string' ? identity.config : identity.system === 'gbrain-shootout' ? `gbrain-shootout ${identity.embedding?.model ?? ''}@${identity.embedding?.dims ?? ''}`.trim() : 'unknown';
  return { dir: resolve(dir), name: String(receipt.system?.capability_system ?? identity.system ?? dir), config, build: identity.gbrain ?? receipt.overlay?.commit ?? null,
    run_status: String(receipt.run_status), fixture_sha256: receipt.upstream?.fixture_sha256 ?? {}, scorer_sha256: receipt.upstream?.scorer_sha256 ?? {}, rows };
}

const round = (x: number | null, d = 4) => x === null ? null : Math.round(x * 10 ** d) / 10 ** d;
const meanOf = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Share of returned items that cite no source (provenance unavailable), over the rows given. */
export function noProvenanceShare(rows: readonly PmbRow[]): { items: number; uncited: number; share: number | null } {
  const items = rows.reduce((s, r) => s + (r.items_returned ?? 0), 0);
  const uncited = rows.reduce((s, r) => s + ((r.items_returned ?? 0) - (r.items_cited ?? r.items_returned ?? 0)), 0);
  return { items, uncited, share: items ? round(uncited / items) : null };
}

export interface Comparison {
  id: string;
  system: string;
  metric: Metric;
  status: 'tested' | 'not-measurable' | 'blocked';
  reading: 'system higher' | 'gbrain higher' | 'not distinguishable' | 'incomplete' | 'not measurable' | 'blocked';
  reasons: string[];
  excluded: { cross_system: number; undefined_system: number; undefined_gbrain: number; undefined_both: number };
  n_pairs?: number;
  n_clusters?: number;
  mean_system?: number;
  mean_gbrain?: number;
  delta?: number;
  ci95?: [number, number] | null;
  p_two_sided?: number;
  p_method?: string;
  p_holm?: number;
  power?: PowerNote;
  no_provenance_share?: number | null;
}

export interface Family {
  baseline: 'master' | 'pin';
  role: string;
  gbrain: { dir: string; build: string | null; config: string; run_status: string };
  holm_family: string[];
  /** Search-only cases with a harness failure (or no row) on any run in the family, excluded from every pair (crossSystemExclusion). */
  excluded_cases: string[];
  exclusion_runs: string[];
  comparisons: Comparison[];
}

const searchOnlyIds = (runs: readonly PmbRun[]) => [...new Set(runs.flatMap(r => r.rows).filter(r => familyOf(r.category) === 'search-only').map(r => r.case_id))].sort();

/**
 * The primary family's pre-pairing join: a search-only case that is a harness failure, or has no row, on any run in
 * the family is excluded from every pair of that family.
 */
export function familyExclusions(runs: readonly PmbRun[]): string[] {
  const ids = searchOnlyIds(runs);
  const bySystem = Object.fromEntries(runs.map((r, i) => {
    const byId = new Map(r.rows.map(x => [x.case_id, x]));
    return [`${i}:${r.name}`, ids.map((id): Observation => {
      const row = byId.get(id);
      const reason = !row ? 'harness error: no row' : HARNESS_FAILURES.has(row.outcome) ? `harness error: ${row.outcome}` : null;
      return { id, cluster: id, value: reason ? null : 1, eligible: !reason, ...(reason ? { reason } : {}) };
    })];
  }));
  return crossSystemExclusion(bySystem).excluded;
}

/** One system against one baseline on one metric, over the search-only cases the family keeps. */
function compare(system: PmbRun, gbrain: PmbRun, metric: Metric, blind: boolean, familyExcluded: ReadonlySet<string>): Comparison {
  const id = `${system.name}:${metric}`;
  const excluded = { cross_system: 0, undefined_system: 0, undefined_gbrain: 0, undefined_both: 0 };
  const base = { id, system: system.name, metric, excluded, no_provenance_share: noProvenanceShare(system.rows.filter(r => r.family === 'search-only')).share };
  if (blind) return { ...base, status: 'not-measurable', reading: 'not measurable', reasons: ['every returned item lacks provenance, so no case maps to beliefs'] };
  const bySys = new Map(system.rows.map(r => [r.case_id, r]));
  const byGb = new Map(gbrain.rows.map(r => [r.case_id, r]));
  const a: Observation[] = [], b: Observation[] = [];
  for (const caseId of searchOnlyIds([system, gbrain])) {
    const s = bySys.get(caseId), g = byGb.get(caseId);
    let reason: string | null = null;
    if (familyExcluded.has(caseId) || !s || !g) { excluded.cross_system++; reason = 'harness failure on a run in the family'; }
    else {
      const sv = s[metric], gv = g[metric];
      if (sv === null && gv === null) { excluded.undefined_both++; reason = `${metric} undefined in both runs`; }
      else if (sv === null) { excluded.undefined_system++; reason = `${metric} undefined for the system`; }
      else if (gv === null) { excluded.undefined_gbrain++; reason = `${metric} undefined for gbrain`; }
    }
    a.push({ id: caseId, cluster: caseId, value: reason ? null : g![metric], eligible: !reason, ...(reason ? { reason } : {}) });
    b.push({ id: caseId, cluster: caseId, value: reason ? null : s![metric], eligible: !reason, ...(reason ? { reason } : {}) });
  }
  let pairs;
  try { pairs = pairObservations(a, b).pairs; }
  catch (e) { return { ...base, status: 'blocked', reading: 'blocked', reasons: [(e as Error).message] }; }
  const stats = clusteredPairedDelta(pairs, { seed: S3_SEED, draws: S3_DRAWS });
  const reasons: string[] = [];
  if (excluded.cross_system / SEARCH_ONLY_CASES > INCOMPLETE_SHARE) reasons.push(`${excluded.cross_system} of ${SEARCH_ONLY_CASES} search-only cases excluded for harness failures in the family (more than 5%)`);
  for (const r of [system, gbrain]) if (r.run_status !== 'complete') reasons.push(`${r.name} run is ${r.run_status}`);
  return { ...base, status: 'tested', reading: reasons.length ? 'incomplete' : 'not distinguishable', reasons,
    n_pairs: stats.n_pairs, n_clusters: stats.n_clusters, mean_system: round(stats.mean_b)!, mean_gbrain: round(stats.mean_a)!, delta: round(stats.delta)!,
    ci95: stats.ci95 ? [round(stats.ci95[0])!, round(stats.ci95[1])!] : null, p_two_sided: stats.p_two_sided, p_method: stats.p_method, power: powerNote(stats, { alpha: S3_ALPHA }) };
}

/**
 * Every system against one baseline, both metrics. The exclusion join runs over the baseline and every system still
 * in the family (a not-measurable system has left it); every tested comparison, incomplete ones included, enters Holm.
 */
export function familyFor(baseline: 'master' | 'pin', gbrain: PmbRun, systems: readonly PmbRun[]): Family {
  const blind = new Set(systems.filter(s => provenanceBlind(s.rows)).map(s => s.name));
  const members = [gbrain, ...systems.filter(s => !blind.has(s.name))];
  const excludedCases = familyExclusions(members);
  const excludedSet = new Set(excludedCases);
  const comparisons = systems.flatMap(s => METRICS.map(m => compare(s, gbrain, m, blind.has(s.name), excludedSet)));
  const tested = comparisons.filter(c => c.status === 'tested');
  const adjusted = tested.length ? holmAdjusted(tested.map(c => c.p_two_sided!)) : [];
  tested.forEach((c, i) => {
    c.p_holm = adjusted[i];
    if (c.reading === 'not distinguishable' && adjusted[i] <= S3_ALPHA && c.delta !== 0) c.reading = c.delta! > 0 ? 'system higher' : 'gbrain higher';
  });
  return {
    baseline, role: baseline === 'master' ? 'preregistered family S3 (gbrain-shootout common at frozen master, amendment A2)' : 'descriptive: the same comparisons against gbrain-shootout common at the repository pin',
    gbrain: { dir: gbrain.dir, build: gbrain.build, config: gbrain.config, run_status: gbrain.run_status }, holm_family: tested.map(c => c.id),
    excluded_cases: excludedCases, exclusion_runs: members.map(m => m.name), comparisons,
  };
}

/** Structural categories, per system and category: means and passes, no tests. */
export function structuralSummary(runs: readonly PmbRun[]) {
  return runs.map(r => {
    const rows = r.rows.filter(x => familyOf(x.category) === 'structural' && !HARNESS_FAILURES.has(x.outcome));
    const cats = [...new Set(rows.map(x => x.category))].sort();
    const stat = (xs: PmbRow[]) => ({ cases: xs.length, passed: xs.filter(x => x.passed).length,
      mean_precision: round(meanOf(xs.map(x => x.precision).filter((v): v is number => v !== null))), mean_recall: round(meanOf(xs.map(x => x.recall).filter((v): v is number => v !== null))) });
    return { system: r.name, build: r.build, harness_failures: r.rows.filter(x => familyOf(x.category) === 'structural' && HARNESS_FAILURES.has(x.outcome)).length, all: stat(rows),
      categories: cats.map(c => ({ category: c, ...stat(rows.filter(x => x.category === c)) })) };
  });
}

export interface S3Verdict {
  kind: 'precisionmembench-s3'; schema_version: 1; contract: string; generated_at: string;
  method: Record<string, unknown>;
  runs: Array<{ role: string; name: string; config: string; build: string | null; run_status: string; dir: string; no_provenance_share: ReturnType<typeof noProvenanceShare>; provenance: 'measurable' | 'not measurable' }>;
  warnings: string[];
  families: Family[];
  structural: ReturnType<typeof structuralSummary>;
}

export function analyzeS3(input: { master: PmbRun; pin?: PmbRun | null; systems: PmbRun[] }): S3Verdict {
  const all = [input.master, ...(input.pin ? [input.pin] : []), ...input.systems];
  const problems: string[] = [];
  const ref = JSON.stringify([input.master.fixture_sha256, input.master.scorer_sha256]);
  for (const r of all) if (JSON.stringify([r.fixture_sha256, r.scorer_sha256]) !== ref) problems.push(`${r.name} (${r.dir}) used a different fixture or scorer than the master baseline`);
  const names = input.systems.map(s => s.name);
  for (const n of new Set(names)) if (names.filter(x => x === n).length > 1) problems.push(`system ${n} given more than once`);
  if (problems.length) throw new Error(`S3 analysis refused: ${problems.join('; ')}`);
  const warnings: string[] = [];
  for (const s of input.systems) if (s.config !== 'common') warnings.push(`${s.name} ran config ${s.config}; S3 compares common configurations`);
  for (const [role, g] of [['master', input.master], ['pin', input.pin]] as const) if (g && !/^gbrain-shootout openai:text-embedding-3-large@1536$/.test(g.config)) warnings.push(`the ${role} baseline (${g.name}) is not gbrain-shootout with the common embedder (${g.config})`);
  return {
    kind: 'precisionmembench-s3', schema_version: 1, contract: CONTRACT, generated_at: new Date().toISOString(),
    method: { cases: 'the 43 search-only cases (categories outside the vendored scorer\'s STRUCTURAL_CATEGORIES); structural categories summarized without tests', clusters: 'one per case',
      pairing: 'pairObservations; delta = system minus gbrain', test: `clusteredPairedDelta, seed ${S3_SEED}, ${S3_DRAWS} draws, two-sided cluster sign-flip p`, correction: `holmAdjusted across each family's tested comparisons, alpha ${S3_ALPHA}`,
      exclusions: 'as in the primary family, crossSystemExclusion: a search-only case with a harness failure (or no row) on any run in the family is excluded from every pair in that family, and counted; following the upstream scorer, a case whose metric is undefined on either side is dropped from that metric, counted per side',
      not_measurable: 'a system whose returned items all lack provenance leaves the Holm family', incomplete: 'as in the primary family: more than 5% of search-only cases excluded (3 or more of 43), or a run invalid or incomplete, reads incomplete with its numbers and no direction, and stays in the Holm family' },
    runs: all.map(r => ({ role: r === input.master ? 'baseline master' : r === input.pin ? 'baseline pin' : 'system', name: r.name, config: r.config, build: r.build, run_status: r.run_status, dir: r.dir,
      no_provenance_share: noProvenanceShare(r.rows.filter(x => x.family === 'search-only')), provenance: provenanceBlind(r.rows) ? 'not measurable' : 'measurable' })),
    warnings,
    families: [familyFor('master', input.master, input.systems), ...(input.pin ? [familyFor('pin', input.pin, input.systems)] : [])],
    structural: structuralSummary(all),
  };
}

const fmt = (x: number | null | undefined, d = 3) => x === null || x === undefined ? 'n/a' : x.toFixed(d);
const pct = (x: number | null | undefined) => x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
const pfmt = (x: number | undefined) => x === undefined ? 'n/a' : x < 0.001 ? '<0.001' : x.toFixed(3);

export function renderMarkdown(v: S3Verdict): string {
  const out: string[] = ['# PrecisionMemBench, family S3', '',
    `${v.contract}. Search-only cases (43), one cluster per case, delta = system minus gbrain, cluster sign-flip test (seed ${S3_SEED}, ${S3_DRAWS} draws), Holm across each family. "Uncited items" is the share of the system's returned items that cite no source, which precision does not count.`, ''];
  for (const f of v.families) {
    out.push(`## Against gbrain-shootout common at ${f.baseline === 'master' ? 'frozen master' : 'the repository pin'}${f.gbrain.build ? ` (${f.gbrain.build.slice(0, 7)})` : ''}`, '', f.role, '',
      '| System | Metric | Pairs | System | gbrain | Delta | 95% interval | p | Holm p | Reading | Excluded (harness / undefined) | Uncited items |',
      '|---|---|---:|---:|---:|---:|---|---:|---:|---|---|---:|');
    for (const c of f.comparisons) {
      const undef = c.excluded.undefined_system + c.excluded.undefined_gbrain + c.excluded.undefined_both;
      out.push(`| ${c.system} | ${c.metric} | ${c.n_pairs ?? 'n/a'} | ${fmt(c.mean_system)} | ${fmt(c.mean_gbrain)} | ${c.delta === undefined ? 'n/a' : (c.delta >= 0 ? '+' : '') + c.delta.toFixed(3)} | ${c.ci95 ? `${c.ci95[0].toFixed(3)} to ${c.ci95[1].toFixed(3)}` : 'n/a'} | ${pfmt(c.p_two_sided)} | ${pfmt(c.p_holm)} | ${c.reading} | ${c.excluded.cross_system} / ${undef} | ${c.metric === 'precision' ? pct(c.no_provenance_share) : ''} |`);
    }
    const notes = [`- Cases excluded from every pair for harness failures on any run in this family: ${f.excluded_cases.length}${f.excluded_cases.length ? ` (${f.excluded_cases.join(', ')})` : ''}.`,
      ...f.comparisons.filter(c => c.reasons.length).map(c => `- ${c.id}: ${c.reasons.join('; ')}`)];
    if (notes.length) out.push('', ...notes);
    out.push('');
  }
  out.push('## Structural categories (no tests)', '', '| System | Build | Cases | Passed | Mean precision | Mean recall |', '|---|---|---:|---:|---:|---:|');
  for (const s of v.structural) out.push(`| ${s.system} | ${s.build ? s.build.slice(0, 7) : ''} | ${s.all.cases} | ${s.all.passed} | ${fmt(s.all.mean_precision)} | ${fmt(s.all.mean_recall)} |`);
  out.push('');
  if (v.warnings.length) out.push('## Warnings', '', ...v.warnings.map(w => `- ${w}`), '');
  return out.join('\n');
}

export function parseS3Args(argv: string[]): { master: string; pin: string | null; systems: string[]; output: string } {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--master', '--pin', '--system', '--output'].includes(argv[i])) throw new Error(`unknown argument ${argv[i]} (valid: --master --pin --system --output)`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
  }
  const master = one('--master'), output = one('--output');
  const systems = argv.flatMap((a, i) => a === '--system' ? [argv[i + 1]] : []);
  if (!master || !output || !systems.length) throw new Error('usage: --master <run dir> [--pin <run dir>] --system <run dir>... --output <dir>');
  return { master, pin: one('--pin') ?? null, systems, output: resolve(output) };
}

if (import.meta.main) {
  const a = parseS3Args(process.argv.slice(2));
  const verdict = analyzeS3({ master: loadRun(a.master), pin: a.pin ? loadRun(a.pin) : null, systems: a.systems.map(loadRun) });
  mkdirSync(a.output, { recursive: true });
  writeFileSync(join(a.output, 's3-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  writeFileSync(join(a.output, 's3-table.md'), renderMarkdown(verdict));
  process.stderr.write(`[precisionmembench-s3] ${verdict.families.map(f => `${f.baseline}: ${f.holm_family.length} tested`).join(', ')}; ${join(a.output, 's3-verdict.json')}\n`);
}

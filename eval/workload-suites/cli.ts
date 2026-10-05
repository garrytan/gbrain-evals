#!/usr/bin/env bun
/**
 * Entry point for the workload suites (memory proof wave B1 to B4).
 *
 *   bun eval/workload-suites/cli.ts <suite|all> [--seed N] [--smoke] [--output DIR]
 *       [--dry-run] [--target-tokens N] [--write-manifest] [--json]
 *
 * Generates the suite from its seed, holds every record to the schema, runs
 * the presence and solvability checks with the stub reader, compares the
 * bundle with its committed manifest (default seed, full size), and writes
 * the harness-ready records plus check-receipt.json to the output directory
 * (default eval/reports/workload-suites/<version>[-smoke]/). No provider is
 * called and no key is read.
 *
 * --dry-run prints the paid-run plan instead: arms, ingest tokens, reader
 * and judge call counts at a delivered-context target. Dollars come from the
 * A0 spend ledger.
 * --write-manifest rewrites eval/data/workload-suites/<version>.manifest.json;
 * use it only in a commit that changes the generator on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beliefs } from './beliefs.ts';
import { runChecks, type CheckReport } from './checks.ts';
import { bundleFiles, bundleManifest, writeBundle, type BundleManifest } from './common.ts';
import { corrections } from './corrections.ts';
import { passingDetails } from './passing-details.ts';
import { MODEL_CONFIG, SUITE_ARMS, dryRunPlan, frontierSubset, modelRuleViolations } from './run-config.ts';
import { schemaErrors } from './schema-check.ts';
import { timeRelationships } from './time-relationships.ts';
import type { SuiteDefinition, SuiteId } from './types.ts';

export const SUITES: Record<SuiteId, SuiteDefinition> = {
  'passing-details': passingDetails,
  corrections,
  'time-relationships': timeRelationships,
  beliefs,
};

const ROOT = join(import.meta.dir, '../..');
export const manifestPath = (suite: SuiteDefinition) => join(ROOT, 'eval/data/workload-suites', `${suite.version}.manifest.json`);

export interface SuiteRun { report: CheckReport; manifest: BundleManifest; manifest_check: 'match' | 'differs' | 'missing' | 'not-applicable'; output: string | null }

export async function runSuite(suite: SuiteDefinition, opts: { seed?: number; smoke?: boolean; output?: string | null; writeManifest?: boolean } = {}): Promise<SuiteRun> {
  const seed = opts.seed ?? suite.defaultSeed;
  const smoke = opts.smoke ?? false;
  const bundle = suite.generate({ seed, smoke });
  bundle.extra['frontier-subset'] = frontierSubset(bundle);
  const report = await runChecks(bundle, suite);
  const files = bundleFiles(bundle);
  const manifest = bundleManifest(bundle, files);
  for (const e of schemaErrors(manifest)) report.schema.failures.push(`${suite.id} manifest: ${e}`);
  let manifestCheck: SuiteRun['manifest_check'] = 'not-applicable';
  if (!smoke && seed === suite.defaultSeed) {
    const path = manifestPath(suite);
    if (opts.writeManifest) {
      mkdirSync(join(ROOT, 'eval/data/workload-suites'), { recursive: true });
      writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    }
    manifestCheck = !existsSync(path) ? 'missing' : (JSON.parse(readFileSync(path, 'utf8')) as BundleManifest).digest === manifest.digest ? 'match' : 'differs';
  }
  if (manifestCheck === 'differs' || manifestCheck === 'missing') report.verdict = 'fail';
  if (report.schema.failures.length) report.verdict = 'fail';
  let output: string | null = null;
  if (opts.output !== null) {
    output = opts.output ?? join(ROOT, 'eval/reports/workload-suites', `${suite.version}${smoke ? '-smoke' : ''}`);
    writeBundle(output, bundle);
    writeFileSync(join(output, 'check-receipt.json'), JSON.stringify({
      generated_by: 'eval/workload-suites/cli.ts', report, manifest_check: manifestCheck,
      models: MODEL_CONFIG, arms: SUITE_ARMS[suite.id], model_rule_violations: modelRuleViolations(),
    }, null, 2) + '\n');
  }
  return { report, manifest, manifest_check: manifestCheck, output };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printRun(run: SuiteRun): void {
  const { report: r, manifest: m } = run;
  const s = r.solvability;
  console.log(`[${r.suite}] verdict: ${r.verdict.toUpperCase()}  (seed ${r.seed}${r.smoke ? ', smoke' : ''})`);
  console.log(`  records: ${m.counts.documents} documents, ${m.counts.queries} queries, ${m.counts.users} isolation units, ~${m.approx_tokens.total} tokens (max ${m.approx_tokens.per_user_max} per unit)`);
  console.log(`  schema: ${r.schema.records} records, ${r.schema.failures.length} failures`);
  console.log(`  presence: ${r.presence.needles} needles, ${r.presence.failures.length} failures`);
  console.log(`  solvability (stub reader): oracle ${s.oracle.correct}/${s.oracle.n} correct; full history ${s.full_history ? `${s.full_history.correct}/${s.full_history.n}` : 'n/a (schedule driver below)'}; no memory ${s.no_memory.correct}/${s.no_memory.n} correct (${s.no_memory.negatives} questions whose answer is "none")`);
  if (r.corrections) {
    const c = r.corrections;
    for (const [arm, t] of Object.entries(c.arms)) console.log(`  corrections ${arm}: before ${t.pre}/${t.n_items}, after 1 write ${t.after_1}/${t.n_items}, after 5 writes ${t.after_5}/${t.n_items}`);
    console.log(`  corrections controls: no memory ${c.no_memory_correct} correct; corrections ignored -> ${c.ignore_corrections_stale}/${2 * c.probes_per_checkpoint} stale`);
  }
  console.log(`  manifest: ${run.manifest_check}  digest ${m.digest.slice(0, 16)}`);
  const failures = [...r.schema.failures, ...r.presence.failures, ...s.oracle.failures, ...(s.full_history?.failures ?? []), ...s.no_memory.failures, ...(r.corrections?.failures ?? [])];
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (run.manifest_check === 'differs') console.log(`  FAIL the bundle differs from eval/data/workload-suites/${m.version}.manifest.json; if the generator change is intended, rerun with --write-manifest and commit the manifest`);
  if (run.output) console.log(`  receipt: ${join(run.output, 'check-receipt.json')}`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const which = argv[0];
  const ids = which === 'all' ? Object.keys(SUITES) as SuiteId[] : [which as SuiteId];
  if (!which || ids.some(id => !SUITES[id])) {
    console.error(`usage: bun eval/workload-suites/cli.ts <${Object.keys(SUITES).join('|')}|all> [--seed N] [--smoke] [--output DIR] [--dry-run] [--target-tokens N] [--write-manifest] [--json]`);
    process.exit(2);
  }
  const seedArg = arg(argv, '--seed');
  const smoke = argv.includes('--smoke');
  const json = argv.includes('--json');
  if (argv.includes('--dry-run')) {
    const target = Number(arg(argv, '--target-tokens') ?? 8000);
    const plans = ids.map(id => dryRunPlan(SUITES[id].generate({ seed: seedArg ? Number(seedArg) : SUITES[id].defaultSeed, smoke }), target));
    if (json) console.log(JSON.stringify({ models: MODEL_CONFIG, plans }, null, 2));
    else {
      console.log(`Paid-run plan (no spend). Fixed reader ${MODEL_CONFIG.fixed_reader.id}; sweep ${MODEL_CONFIG.frontier_sweep.map(m => m.id).join(', ')}; judge ${MODEL_CONFIG.judge.id} (${MODEL_CONFIG.status}).`);
      for (const p of plans) console.log(`  ${p.suite}: ${p.arms} arms, ~${p.ingest_tokens_per_arm} ingest tokens per arm, ${p.reader_calls.fixed} fixed-reader calls + ${p.reader_calls.frontier_sweep} sweep calls, ~${p.reader_input_tokens} reader input tokens, at most ${p.judge_calls_max} judge calls`);
      console.log(`  ${plans[0]!.note}`);
    }
    process.exit(0);
  }
  const output = arg(argv, '--output');
  let failed = false;
  const runs: SuiteRun[] = [];
  for (const id of ids) {
    const run = await runSuite(SUITES[id], { seed: seedArg ? Number(seedArg) : undefined, smoke, output: output && ids.length > 1 ? join(output, id) : output, writeManifest: argv.includes('--write-manifest') });
    runs.push(run);
    if (run.report.verdict !== 'pass') failed = true;
    if (!json) printRun(run);
  }
  if (json) console.log(JSON.stringify(runs.map(r => ({ ...r.report, manifest: r.manifest, manifest_check: r.manifest_check, output: r.output })), null, 2));
  const violations = modelRuleViolations();
  if (violations.length) { console.error(`model rule: ${violations.join('; ')}`); failed = true; }
  process.exit(failed ? 1 : 0);
}

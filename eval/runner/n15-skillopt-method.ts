/**
 * BrainBench N15: SkillOpt method benchmark, Phase 1 (GST-799).
 *
 * Question: can we tell skill optimizers apart on gbrain's own shipped skills
 * (query, briefing, fact-check)? Phase 1 builds the measuring stick: frozen
 * task sets over messy-company-v1 and world-v1 with gold from labels and
 * structured fields, each confirmed by an independent oracle, a binary
 * counted scorer in each skill's own output contract, one criteria text per
 * skill, verbatim seeds and the A1 headroom probe. No optimizer is compared
 * here; the plan's Phase 2 (rollout server and ledger) is built only if the
 * probe's preregistered gate says so.
 *
 * The probe reads skillopt-method-v2, the hardening after probe 1 found v1
 * saturated; v1 stays frozen and is checked here too.
 *
 * Hermetic run (default, keyless, report-only):
 *   1. both dataset versions regenerate byte for byte and match their
 *      MANIFEST.json;
 *   2. each seed SKILL.md, in both versions, matches its sha256 at gbrain
 *      3ec766c40;
 *   3. on train and selection of both versions, every solvability-control
 *      answer passes its judge, and an empty answer and "I don't know" fail
 *      every task that is not a negative control;
 *   4. the tool coverage of each seed against what the rollout serves;
 *   5. the A1 probe end to end on a deterministic in-process transport (no
 *      model call), which must read no test file.
 *
 * n_total counts the dataset check, then per skill the seed, scorer and fake
 * probe checks. The verdict is pass when all of them hold; nothing gates.
 *
 * Paid A1 probe: `--probe --paid --budget-run-id <id> [--skills a,b]
 * [--after-hardening]`, against the preregistration in
 * docs/benchmarks/2026-11-01-skillopt-method/PREREGISTRATION.md (attested at
 * start). `--probe --fake` runs only step 5.
 *
 * Usage: bun eval/runner/n15-skillopt-method.ts [--output <dir>] [--json]
 *        bun eval/runner/n15-skillopt-method.ts --probe --paid --budget-run-id <id> [--skills query,briefing,fact-check] [--after-hardening] [--output <dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { datasetProblems } from '../generators/skillopt-method/gen.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, PaidArmRefusal, requirePaidArm } from './paid-arm.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, productIdentity, receiptPath, sourceTreeIdentity, writeReceipt, type ProbeError, type Receipt } from './receipt.ts';
import { auditSkill } from './skillopt-method/audit.ts';
import { DATASET_VERSIONS, datasetDir, datasetName, DEFAULT_DATASET, readCriteria, readSeed, readTasks, SEED_GBRAIN_COMMIT, sha256, type DatasetVersion } from './skillopt-method/dataset.ts';
import { PROBE_ESTIMATE_USD, PROBE_MODELS, runProbe, toolCoverage, type ProbeResult, type ProbeSkillResult } from './skillopt-method/probe.ts';
import { evaluateJudge, SKILLS, type SkillName } from './skillopt-method/score.ts';

export const CATEGORY = 'n15-skillopt-method';
export const PREREGISTRATION = 'docs/benchmarks/2026-11-01-skillopt-method/PREREGISTRATION.md';
/** Default models, registered in test/eval/model-defaults.test.ts. */
export const DEFAULT_TARGET_MODEL = PROBE_MODELS.target;
export const DEFAULT_PROPOSER_MODEL = PROBE_MODELS.proposer;

export interface IntegrityResult {
  dataset_problems: string[];
  seed_problems: string[];
  /** Per dataset version and skill ("v2 query"): solvability controls that fail, and degenerate answers that pass, on train and selection. */
  scorer: Record<string, { tasks: number; controls_failing: string[]; degenerate_passing: string[] }>;
}

export function checkIntegrity(): IntegrityResult {
  const seed_problems: string[] = [];
  const scorer: IntegrityResult['scorer'] = {};
  for (const v of DATASET_VERSIONS) for (const s of SKILLS) {
    try { readSeed(s, v); } catch (e) { seed_problems.push(`${v}: ${(e as Error).message}`); }
    const tasks = [...readTasks(s, 'train', v), ...readTasks(s, 'sel', v)];
    const controls_failing = tasks.filter(t => !evaluateJudge(t.oracle_answer, t.judge).correct).map(t => t.task_id);
    const degenerate_passing = tasks.filter(t => t.answerable && ['', "I don't know."].some(a => evaluateJudge(a, t.judge).correct)).map(t => t.task_id);
    scorer[`${v} ${s}`] = { tasks: tasks.length, controls_failing, degenerate_passing };
  }
  return { dataset_problems: DATASET_VERSIONS.flatMap(datasetProblems), seed_problems, scorer };
}

const integrityOk = (r: IntegrityResult) => !r.dataset_problems.length && !r.seed_problems.length && Object.values(r.scorer).every(x => !x.controls_failing.length && !x.degenerate_passing.length);

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function parseSkills(argv: readonly string[]): SkillName[] {
  const raw = argValue(argv, '--skills');
  if (!raw) return [...SKILLS];
  const skills = raw.split(',').map(s => s.trim());
  const bad = skills.filter(s => !(SKILLS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`--skills: unknown skill ${bad.join(', ')} (have ${SKILLS.join(', ')})`);
  return skills as SkillName[];
}

/** The probe result as a receipt payload: per-task rows, rewrites audited, the texts themselves left out. */
function probeData(p: ProbeResult) {
  return {
    ...p,
    skills: p.skills.map(({ rewrites, ...s }) => ({ ...s, rewrite_audits: rewrites.map(text => auditSkill(s.skill, text)) })),
    files_read_include_test: p.files_read.some(f => f.endsWith('/test.jsonl')),
  };
}

const manifestSha = (v: DatasetVersion) => sha256(readFileSync(join(datasetDir(v), 'MANIFEST.json')));

function baseReceipt(startedAt: string) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentity() },
    hashes: {
      dataset: datasetName(DEFAULT_DATASET),
      dataset_manifest_sha256: manifestSha(DEFAULT_DATASET),
      ...Object.fromEntries(DATASET_VERSIONS.filter(v => v !== DEFAULT_DATASET).map(v => [`${datasetName(v)}_manifest_sha256`, manifestSha(v)])),
      ...Object.fromEntries(SKILLS.map(s => [`criteria_${s}_sha256`, sha256(readCriteria(s))])),
      seeds_gbrain_commit: SEED_GBRAIN_COMMIT,
    },
    started_at: startedAt,
  } as const;
}

async function runHermetic(argv: readonly string[], log: (s: string) => void): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: ProbeError[] = [];
  const integrity = checkIntegrity();
  const coverage = toolCoverage();
  let probe: ProbeResult | null = null;
  try {
    probe = await withHermeticEnv('n15-fake-probe', async () => runProbe({ fake: true, log }));
  } catch (e) {
    errors.push({ probe_id: 'fake-probe', origin: 'harness', message: (e as Error).message });
  }
  const probeOk = !!probe && !probe.files_read.some(f => f.endsWith('/test.jsonl')) && probe.skills.every(s => s.seed !== null && s.no_skill !== null && s.one_shot_kept !== null && s.seed_opus !== null);
  if (probe && !probeOk) errors.push({ probe_id: 'fake-probe', origin: 'harness', message: 'the fake probe read a test file or left an arm unscored' });
  const ok = integrityOk(integrity) && probeOk;
  const planned = 1 + SKILLS.length * 3;
  const scored = probe ? planned : planned - SKILLS.length;
  return {
    ...baseReceipt(startedAt),
    ...noModelSpend('hermetic: provider keys stripped, the A1 probe runs on an in-process fake chat transport; no model and no paid request'),
    run_status: probe ? 'completed' : 'error',
    ...(probe ? { verdict: ok ? 'pass' as const : 'fail' as const } : {}),
    n_total: planned, n_scored: scored, completion_rate: scored / planned, errors,
    publishable: !!probe,
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: 'hermetic', models: PROBE_MODELS, runtime_ms: Date.now() - t0 },
    finished_at: new Date().toISOString(),
    data: { integrity, coverage, fake_probe: probe ? probeData(probe) : null, argv: argv.filter(a => a !== '--json') },
  };
}

async function runLiveProbe(argv: readonly string[], log: (s: string) => void, outDir: string): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const skills = parseSkills(argv);
  const estimateUsd = PROBE_ESTIMATE_USD * skills.length / SKILLS.length;
  requirePaidArm(argv, { arm: 'n15 A1 headroom probe', estimateUsd });
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new PaidArmRefusal('n15 A1 probe: ANTHROPIC_API_KEY is not set');
  const attestation: Attestation = attestPreregistration(PREREGISTRATION);
  const { run, guard } = startPaidRun(`${CATEGORY}-probe`, { ...budgetOptionsFrom(argv), estimateUsd, log });
  let probe: ProbeResult | null = null;
  let cost: RunSummary | null = null;
  const errors: ProbeError[] = [];
  try {
    probe = await withHermeticEnv('n15-probe', async () => {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
      const done: ProbeSkillResult[] = [];
      const partialPath = join(outDir, 'probe-partial.json');
      return runProbe({
        fake: false, skills, afterHardening: argv.includes('--after-hardening'), log,
        onSkill: result => {
          done.push(result);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(partialPath, JSON.stringify({ category: CATEGORY, started_at: startedAt, skills: done.map(({ rewrites, ...s }) => ({ ...s, rewrite_audits: rewrites.map(text => auditSkill(s.skill, text)) })) }, null, 2) + '\n');
        },
      });
    });
  } catch (e) {
    errors.push({ probe_id: 'probe', origin: 'harness', message: (e as Error).message });
  } finally {
    guard.uninstall();
    cost = run.close();
  }
  for (const s of probe?.skills ?? []) {
    const arms = [['no_skill', s.arms.no_skill], ['seed', s.arms.seed], ['seed_opus', s.arms.seed_opus], ...s.arms.one_shot.map((a, i) => [`one_shot_${i + 1}`, a] as const)] as const;
    for (const [arm, a] of arms) if (a.score === null) errors.push({ probe_id: `${s.skill}:${arm}`, origin: 'dependency', message: a.error ?? ('rewrite_error' in a ? String(a.rewrite_error) : 'unscored') });
  }
  const planned = skills.length * 5;
  const scored = planned - errors.filter(e => e.probe_id !== 'probe').length;
  return {
    ...baseReceipt(startedAt),
    cost: cost ? receiptCost(cost) : null,
    run_status: probe ? 'completed' : 'error',
    ...(probe ? { verdict: scored === planned ? 'pass' as const : 'partial' as const } : {}),
    n_total: planned, n_scored: probe ? scored : 0, completion_rate: probe ? scored / planned : 0, errors,
    publishable: !!probe && scored === planned,
    preregistration_attestation: attestation,
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: 'probe', skills, models: PROBE_MODELS, after_hardening: argv.includes('--after-hardening') },
    finished_at: new Date().toISOString(),
    data: { probe: probe ? probeData(probe) : null },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const output = argValue(argv, '--output');
  const probeMode = argv.includes('--probe');
  const outPath = output ? join(output, 'receipt.json') : probeMode ? join(process.cwd(), 'eval/reports', CATEGORY, 'probe', 'receipt.json') : receiptPath(CATEGORY);
  log(`# BrainBench N15: SkillOpt method benchmark, Phase 1 (gbrain ${gbrainVersion()})`);
  let receipt: Receipt;
  if (probeMode && !argv.includes('--fake')) {
    if (!paidRequested(argv)) log('The live A1 probe spends money; pass --paid --budget-run-id <id> (or --fake for the keyless path).');
    receipt = await runLiveProbe(argv, log, dirname(outPath));
  } else {
    receipt = await runHermetic(argv, log);
  }
  writeReceipt(outPath, receipt);
  const d = receipt.data as Record<string, any>;
  const p = (d.probe ?? d.fake_probe) as ReturnType<typeof probeData> | null;
  if (d.integrity) {
    const i = d.integrity as IntegrityResult;
    log(`\nverdict: ${receipt.verdict ?? receipt.run_status} (report-only; nothing gates)`);
    log(`datasets: ${i.dataset_problems.length ? i.dataset_problems.join('; ') : `${DATASET_VERSIONS.join(' and ')} regenerate byte for byte and match their MANIFEST.json; the probe reads ${datasetName(DEFAULT_DATASET)}`}`);
    log(`seeds: ${i.seed_problems.length ? i.seed_problems.join('; ') : `all match their sha256 at gbrain ${SEED_GBRAIN_COMMIT.slice(0, 9)}`}`);
    for (const [s, x] of Object.entries(i.scorer)) log(`scorer ${s}: ${x.tasks - x.controls_failing.length}/${x.tasks} solvability controls pass; ${x.degenerate_passing.length} degenerate answers pass`);
  }
  if (p) {
    for (const c of p.coverage) log(`tools ${c.skill}: ${c.full ? 'every frontmatter brain operation is served' : `not served: ${c.missing.join(', ')}`}${c.outside_brain.length ? `; outside the brain: ${c.outside_brain.join(', ')}` : ''}`);
    for (const s of p.skills) log(`probe ${s.skill}${p.mode === 'fake' ? ' (fake transport)' : ''}: no-skill ${s.no_skill}, seed ${s.seed}, one-shot ${s.one_shot_repeats.join('/')} kept ${s.one_shot_kept}, seed on Opus ${s.seed_opus}, ceiling ${s.ceiling}`);
    log(`gate: ${p.gate.verdict}${p.gate.waits_for_rerun.length ? ` (waits for a rerun of ${p.gate.waits_for_rerun.join(', ')})` : ''}${p.mode === 'fake' ? ' (fake numbers; proves the path, not the gate)' : ''}`);
  }
  if (receipt.errors.length) for (const e of receipt.errors) log(`error ${e.probe_id} (${e.origin}): ${e.message}`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, gate: p?.gate ?? null }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => {
    if (e instanceof PaidArmRefusal) { console.error(e.message); process.exit(2); }
    console.error(e);
    process.exit(3);
  });
}

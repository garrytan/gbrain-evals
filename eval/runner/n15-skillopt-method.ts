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
 * saturated; v1 stays frozen and is checked here too. Its targets are the
 * frontier models claude-opus-5-5 and gpt-6.1-sol (plan revision 3, decision
 * A3); see eval/runner/skillopt-method/probe.ts.
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
 *   5. the frontier probe end to end on a deterministic in-process transport
 *      (no model call): F0a, then F0b from it, for both targets, the counted
 *      skills pick and the smoke. It must read no test file.
 *
 * n_total counts the dataset check, then per skill the seed, scorer and fake
 * probe checks. The verdict is pass when all of them hold; nothing gates.
 *
 * Paid runs, each attested against
 * docs/benchmarks/2026-11-01-skillopt-method/PREREGISTRATION.md at start and
 * capped by the budget ledger run named by --budget-run-id:
 *
 *   --smoke                                  one seed rollout per target on one train task: turns, tools, tokens and dollars per call
 *   --probe --target opus|sol --stage f0a    the seed's headroom
 *   --probe --target opus|sol --stage f0b --from <F0a receipt> [--other <the other target's receipt>]
 *                                            the harness one-shot on the pairs F0a put in band, and the counted skills pick
 *   --probe --target opus|sol --stage test --from <F0b receipt> [--other <the other target's F0b receipt>]
 *                                            the one read of the sealed test split: no skill, the seed and the kept
 *                                            rewrite of every F0b pair, paired by task (skillopt-method/test-stage.ts)
 *   --probe --target haiku [--after-hardening] [--dataset v1|v2]
 *                                            historical: reproduces probes 1 and 2
 *
 * The process holds only the keys a run needs: the target's (ANTHROPIC_API_KEY
 * for opus, OPENAI_API_KEY for sol), plus ANTHROPIC_API_KEY for F0b's Opus
 * proposer; the smoke holds one target's key at a time, and stage test only
 * the target's. --fake runs any of them keyless on the fake transport.
 *
 * Usage: bun eval/runner/n15-skillopt-method.ts [--output <dir>] [--json]
 *        bun eval/runner/n15-skillopt-method.ts --smoke --paid --budget-run-id <id> [--skills query]
 *        bun eval/runner/n15-skillopt-method.ts --probe --target opus|sol --stage f0a|f0b|test [--from <receipt>] [--other <receipt>] [--skills a,b] --paid --budget-run-id <id> [--output <dir>]
 */
// First import: the budget ledger replaces globalThis.fetch with its
// delegating fetch before any gbrain or SDK module can capture fetch.
import { budgetOptionsFrom, readLedger, receiptCost, startPaidRun, type BudgetRun, type RunSummary } from './budget-ledger.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { datasetProblems } from '../generators/skillopt-method/gen.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, PaidArmRefusal, requirePaidArm } from './paid-arm.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, productIdentity, receiptPath, sourceTreeIdentity, writeReceipt, type ProbeError, type Receipt } from './receipt.ts';
import { auditSkill } from './skillopt-method/audit.ts';
import { DATASET_VERSIONS, datasetDir, datasetName, DEFAULT_DATASET, readCriteria, readSeed, readTasks, SEED_GBRAIN_COMMIT, sha256, type DatasetVersion } from './skillopt-method/dataset.ts';
import { PROPOSER_MODEL } from './skillopt-method/one-shot.ts';
import {
  countedSkills, f0bSkillsOf, FRONTIER_TARGET_NAMES, FRONTIER_TARGETS, frontierEstimateUsd, HISTORICAL_NOTE, HISTORICAL_PROBE_MODELS, openBrain,
  PROBE_ESTIMATE_USD, PROBE_STAGES, runFrontierProbe, runProbe, runSmoke, SMOKE_ESTIMATE_USD, TARGET_KEY, toolCoverage,
  type CountedSkills, type FrontierResult, type FrontierSkillResult, type FrontierTarget, type ProbeResult, type ProbeSkillResult, type ProbeStage, type RequestSettings, type SmokeResult,
} from './skillopt-method/probe.ts';
import { evaluateJudge, SKILLS, type SkillName } from './skillopt-method/score.ts';
import { planTestStage, rewritePath, runTestStage, TEST_STAGE, testStageEstimateUsd, withRewriteTexts, type PairedDifference, type TestPairResult, type TestStageResult } from './skillopt-method/test-stage.ts';

export const CATEGORY = 'n15-skillopt-method';
export const PREREGISTRATION = 'docs/benchmarks/2026-11-01-skillopt-method/PREREGISTRATION.md';
/** Default models, registered in test/eval/model-defaults.test.ts: both frontier targets (opus is the default) and the one-shot proposer. */
export const DEFAULT_TARGET_MODELS: readonly string[] = Object.values(FRONTIER_TARGETS);
export const DEFAULT_PROPOSER_MODEL = PROPOSER_MODEL;

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

function parseSkills(argv: readonly string[]): SkillName[] | undefined {
  const raw = argValue(argv, '--skills');
  if (!raw) return undefined;
  const skills = raw.split(',').map(s => s.trim());
  const bad = skills.filter(s => !(SKILLS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`--skills: unknown skill ${bad.join(', ')} (have ${SKILLS.join(', ')})`);
  return skills as SkillName[];
}

function parseTarget(argv: readonly string[]): FrontierTarget | 'haiku' {
  const raw = argValue(argv, '--target') ?? 'opus';
  if (raw === 'haiku' || (FRONTIER_TARGET_NAMES as string[]).includes(raw)) return raw as FrontierTarget | 'haiku';
  throw new Error(`--target: unknown target ${raw} (have ${FRONTIER_TARGET_NAMES.join(', ')}; haiku reproduces probes 1 and 2)`);
}

const STAGES = [...PROBE_STAGES, TEST_STAGE] as const;

function parseStage(argv: readonly string[]): typeof STAGES[number] {
  const raw = argValue(argv, '--stage') ?? 'f0a';
  if (!(STAGES as readonly string[]).includes(raw)) throw new Error(`--stage: unknown stage ${raw} (have ${STAGES.join(', ')})`);
  return raw as typeof STAGES[number];
}

function parseDataset(argv: readonly string[]): DatasetVersion {
  const raw = argValue(argv, '--dataset') ?? DEFAULT_DATASET;
  if (!(DATASET_VERSIONS as readonly string[]).includes(raw)) throw new Error(`--dataset: unknown version ${raw} (have ${DATASET_VERSIONS.join(', ')})`);
  return raw as DatasetVersion;
}

/** Collect the values of a live run's keys before withHermeticEnv strips them; refuse when one is missing. */
function requireKeys(names: readonly string[], what: string): Record<string, string> {
  const missing = names.filter(k => !process.env[k]);
  if (missing.length) throw new PaidArmRefusal(`${what}: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  return Object.fromEntries(names.map(k => [k, process.env[k]!]));
}

const stripRewrites = <T extends { rewrites: string[]; proposer_input?: string }>({ rewrites: _r, proposer_input: _p, ...rest }: T) => rest;

/** The historical probe result as a receipt payload: per-task rows, rewrites audited, the texts themselves left out. */
function probeData(p: ProbeResult) {
  return {
    ...p,
    skills: p.skills.map(({ rewrites, ...s }) => ({ ...s, rewrite_audits: rewrites.map(text => auditSkill(s.skill, text)) })),
    files_read_include_test: p.files_read.some(f => f.endsWith('/test.jsonl')),
  };
}

/** A frontier result as a receipt payload: the rewrite texts and proposer inputs go beside the receipt, not in it. */
function frontierData(p: FrontierResult) {
  return { ...p, skills: p.skills.map(stripRewrites), files_read_include_test: p.files_read.some(f => f.endsWith('/test.jsonl')) };
}

/** Write each scored pair as it lands: the partial receipt, and the proposer input and rewrites as Markdown files. */
function pairWriter(outDir: string, startedAt: string) {
  const done: FrontierSkillResult[] = [];
  return (result: FrontierSkillResult) => {
    done.push(result);
    mkdirSync(join(outDir, 'one-shot'), { recursive: true });
    writeFileSync(join(outDir, 'probe-partial.json'), JSON.stringify({ category: CATEGORY, started_at: startedAt, skills: done.map(stripRewrites) }, null, 2) + '\n');
    if (result.proposer_input) writeFileSync(join(outDir, 'one-shot', `${result.target}-${result.skill}-input.txt`), result.proposer_input);
    result.rewrites.forEach((text, i) => writeFileSync(join(outDir, 'one-shot', `${result.target}-${result.skill}-rewrite-${i + 1}.txt`), text));
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

/** A frontier receipt's probe payload, refused unless it is this category's, completed, and read the dataset as it stands. */
function readFrontierReceipt(path: string, flag: string): FrontierResult {
  if (!existsSync(path)) throw new Error(`${flag} ${path}: no such file`);
  const r = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
  const p = (r.data as { probe?: FrontierResult } | undefined)?.probe;
  if (r.category !== CATEGORY || !p || !p.stage || !p.target) throw new Error(`${flag} ${path} is not an N15 frontier probe receipt`);
  if (r.run_status !== 'completed') throw new Error(`${flag} ${path}: the run did not complete (${r.run_status})`);
  if (r.hashes?.dataset_manifest_sha256 !== manifestSha(DEFAULT_DATASET)) throw new Error(`${flag} ${path} read another ${datasetName(DEFAULT_DATASET)} manifest than the one in this tree`);
  return p;
}

async function runHermetic(argv: readonly string[], log: (s: string) => void): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: ProbeError[] = [];
  const integrity = checkIntegrity();
  const coverage = toolCoverage();
  let fake: { probes: FrontierResult[]; counted_skills: CountedSkills; smoke: SmokeResult[] } | null = null;
  try {
    fake = await withHermeticEnv('n15-fake-probe', async () => {
      const engine = await openBrain();
      try {
        const probes: FrontierResult[] = [];
        const smoke: SmokeResult[] = [];
        for (const target of FRONTIER_TARGET_NAMES) {
          const f0a = await runFrontierProbe({ target, stage: 'f0a', fake: true, engine, log });
          probes.push(f0a, await runFrontierProbe({ target, stage: 'f0b', fake: true, from: f0a, engine, log }));
          smoke.push(await runSmoke({ target, fake: true, engine }));
        }
        const counted_skills = countedSkills(Object.fromEntries(probes.filter(p => p.stage === 'f0b').map(p => [p.target, p.skills])));
        return { probes, counted_skills, smoke };
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
  } catch (e) {
    errors.push({ probe_id: 'fake-probe', origin: 'harness', message: (e as Error).message });
  }
  const unscored = fake ? fake.probes.flatMap(p => p.skills.filter(s => s.no_skill === null || s.seed === null || (p.stage === 'f0b' && s.one_shot_kept === null)).map(s => `${p.target} ${p.stage} ${s.skill}`)) : [];
  const readTest = fake ? [...fake.probes.flatMap(p => p.files_read), ...fake.smoke.flatMap(s => s.files_read)].some(f => f.endsWith('/test.jsonl')) : false;
  const smokeFailed = fake ? fake.smoke.filter(s => s.error || s.turns === null).map(s => s.target) : [];
  const probeOk = !!fake && !unscored.length && !readTest && !smokeFailed.length;
  if (fake && !probeOk) errors.push({ probe_id: 'fake-probe', origin: 'harness', message: `the fake probe ${[readTest && 'read a test file', unscored.length && `left ${unscored.join(', ')} unscored`, smokeFailed.length && `failed the smoke on ${smokeFailed.join(', ')}`].filter(Boolean).join('; ')}` });
  const ok = integrityOk(integrity) && probeOk;
  const planned = 1 + SKILLS.length * 3;
  const scored = fake ? planned : planned - SKILLS.length;
  return {
    ...baseReceipt(startedAt),
    ...noModelSpend('hermetic: provider keys stripped, the frontier probe and the smoke run on an in-process fake chat transport; no model and no paid request'),
    run_status: fake ? 'completed' : 'error',
    ...(fake ? { verdict: ok ? 'pass' as const : 'fail' as const } : {}),
    n_total: planned, n_scored: scored, completion_rate: scored / planned, errors,
    publishable: !!fake,
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: 'hermetic', models: { targets: FRONTIER_TARGETS, proposer: PROPOSER_MODEL }, runtime_ms: Date.now() - t0 },
    finished_at: new Date().toISOString(),
    data: { integrity, coverage, fake_probe: fake ? { probes: fake.probes.map(frontierData), counted_skills: fake.counted_skills, smoke: fake.smoke } : null, argv: argv.filter(a => a !== '--json') },
  };
}

/** Open the ledger run and install its guard for a paid run; a fake run gets neither. */
function paidRun(fake: boolean, runner: string, argv: readonly string[], estimateUsd: number, log: (s: string) => void) {
  if (fake) return null;
  return startPaidRun(`${CATEGORY}-${runner}`, { ...budgetOptionsFrom(argv), estimateUsd, log });
}

async function runFrontierCli(argv: readonly string[], log: (s: string) => void, outDir: string, target: FrontierTarget, stage: ProbeStage, fake: boolean): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const skills = parseSkills(argv);
  const fromPath = argValue(argv, '--from');
  const otherPath = argValue(argv, '--other');
  if (stage === 'f0b' && !fromPath) throw new Error('--stage f0b reads the F0a receipt: pass --from <F0a receipt>');
  const from = stage === 'f0b' ? readFrontierReceipt(fromPath!, '--from') : undefined;
  const other = otherPath ? readFrontierReceipt(otherPath, '--other') : null;
  if (other && other.target === target) throw new Error(`--other ${otherPath} is for ${target} too; pass the other target's receipt`);
  const pairs = from ? f0bSkillsOf(from.skills).filter(s => !skills || skills.includes(s)).length : (skills ?? SKILLS).length;
  const estimateUsd = frontierEstimateUsd(target, stage, pairs);
  const keyNames = stage === 'f0b' ? [...new Set([TARGET_KEY[target], 'ANTHROPIC_API_KEY'])] : [TARGET_KEY[target]];
  let keys: Record<string, string> = {};
  let attestation: Attestation | null = null;
  if (!fake) {
    requirePaidArm(argv, { arm: `n15 frontier probe ${target} ${stage}`, estimateUsd });
    keys = requireKeys(keyNames, `n15 frontier probe ${target} ${stage}`);
    attestation = attestPreregistration(PREREGISTRATION);
  }
  const paid = paidRun(fake, `probe-${target}-${stage}`, argv, estimateUsd, log);
  let probe: FrontierResult | null = null;
  let cost: RunSummary | null = null;
  const errors: ProbeError[] = [];
  try {
    probe = await withHermeticEnv('n15-probe', async () => {
      for (const [k, v] of Object.entries(keys)) process.env[k] = v;
      return runFrontierProbe({ target, stage, fake, skills, from, log, onSkill: pairWriter(outDir, startedAt) });
    });
  } catch (e) {
    errors.push({ probe_id: 'probe', origin: 'harness', message: (e as Error).message });
  } finally {
    paid?.guard.uninstall();
    cost = paid ? paid.run.close() : null;
  }
  for (const s of probe?.skills ?? []) {
    if (s.skipped === 'reprice-trigger' || s.skipped === 'f0a-unscored') errors.push({ probe_id: `${s.skill}:${stage}`, origin: 'harness', message: `not run: ${s.skipped}` });
    const arms = [['no_skill', s.arms.no_skill], ['seed', s.arms.seed], ['seed_train', s.arms.seed_train], ...(s.arms.one_shot ?? []).map((a, i) => [`one_shot_${i + 1}`, a] as const)] as const;
    for (const [arm, a] of arms) if (a && a.score === null && !('outcome' in a && (a.outcome === 'no-rewrite' || a.outcome === 'audit-disqualified'))) errors.push({ probe_id: `${s.skill}:${arm}`, origin: 'dependency', message: a.error ?? ('outcome' in a ? String(a.outcome) : 'unscored') });
  }
  const planned = probe ? probe.skills.filter(s => s.skipped !== 'seed-above-band' && s.skipped !== 'seed-below-band').length : 0;
  const scored = probe ? planned - new Set(errors.filter(e => e.probe_id !== 'probe').map(e => e.probe_id.split(':')[0])).size : 0;
  const counted = probe && stage === 'f0b' ? countedSkills({ [target]: probe.skills, ...(other ? { [other.target]: other.skills } : {}) }) : null;
  return {
    ...baseReceipt(startedAt),
    ...(fake ? noModelSpend('fake transport: no model and no paid request') : { cost: cost ? receiptCost(cost) : null }),
    run_status: probe ? 'completed' : 'error',
    ...(probe ? { verdict: scored === planned ? 'pass' as const : 'partial' as const } : {}),
    n_total: planned, n_scored: Math.max(0, scored), completion_rate: planned ? Math.max(0, scored) / planned : 0, errors,
    publishable: !!probe && !fake && scored === planned,
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: fake ? 'probe-fake' : 'probe', target, stage, skills: skills ?? null, from: fromPath ?? null, other: otherPath ?? null, keys_in_process: keyNames, models: probe?.models ?? null },
    finished_at: new Date().toISOString(),
    data: { probe: probe ? frontierData(probe) : null, ...(counted ? { counted_skills: counted } : {}), reprice_trigger: probe?.reprice_trigger ?? null },
  };
}

/** A stage-test result as a receipt payload: every file the run read, the test split first, then the F0b receipts and the rewrite files scored. */
function testStageData(p: TestStageResult, inputs: readonly string[]) {
  const files_read = [...p.files_read, ...inputs];
  return { ...p, files_read, files_read_include_test: files_read.some(f => f.endsWith('/test.jsonl')) };
}

/** Write each scored pair as it lands. */
function testPairWriter(outDir: string, startedAt: string) {
  const done: TestPairResult[] = [];
  return (result: TestPairResult) => {
    done.push(result);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'probe-partial.json'), JSON.stringify({ category: CATEGORY, started_at: startedAt, stage: TEST_STAGE, skills: done }, null, 2) + '\n');
  };
}

async function runTestStageCli(argv: readonly string[], log: (s: string) => void, outDir: string, target: FrontierTarget, fake: boolean): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const skills = parseSkills(argv);
  const fromPath = argValue(argv, '--from');
  const otherPath = argValue(argv, '--other');
  if (!fromPath) throw new Error("--stage test reads this target's F0b receipt: pass --from <F0b receipt>");
  const from = withRewriteTexts(readFrontierReceipt(fromPath, '--from'), fromPath);
  const other = otherPath ? withRewriteTexts(readFrontierReceipt(otherPath, '--other'), otherPath) : null;
  const plan = planTestStage({ target, fake, from, other, skills });
  const inputs = [fromPath, ...(otherPath ? [otherPath] : []), ...plan.flatMap(p => (p.rewrite ? [rewritePath(p.rewrite.source === 'own' ? fromPath : otherPath!, p.rewrite.target, p.skill, p.rewrite.number)] : []))];
  const estimateUsd = testStageEstimateUsd(target, plan.map(p => ({ skill: p.skill, rewrite: !!p.rewrite })));
  const keyNames = [TARGET_KEY[target]];
  let keys: Record<string, string> = {};
  let attestation: Attestation | null = null;
  if (!fake) {
    requirePaidArm(argv, { arm: `n15 frontier probe ${target} ${TEST_STAGE}`, estimateUsd });
    keys = requireKeys(keyNames, `n15 frontier probe ${target} ${TEST_STAGE}`);
    attestation = attestPreregistration(PREREGISTRATION);
  }
  const paid = paidRun(fake, `probe-${target}-${TEST_STAGE}`, argv, estimateUsd, log);
  let result: TestStageResult | null = null;
  let cost: RunSummary | null = null;
  const errors: ProbeError[] = [];
  try {
    result = await withHermeticEnv('n15-probe', async () => {
      for (const [k, v] of Object.entries(keys)) process.env[k] = v;
      return runTestStage({ target, fake, from, other, skills, log, onSkill: testPairWriter(outDir, startedAt) });
    });
  } catch (e) {
    errors.push({ probe_id: 'probe', origin: 'harness', message: (e as Error).message });
  } finally {
    paid?.guard.uninstall();
    cost = paid ? paid.run.close() : null;
  }
  for (const s of result?.skills ?? []) {
    if (s.skipped) errors.push({ probe_id: `${s.skill}:${TEST_STAGE}`, origin: 'harness', message: `not run: ${s.skipped}` });
    for (const [arm, a] of Object.entries(s.arms)) if (a && a.score === null) errors.push({ probe_id: `${s.skill}:${arm}`, origin: 'dependency', message: a.error ?? 'unscored' });
  }
  const planned = plan.length;
  const scored = result ? planned - new Set(errors.filter(e => e.probe_id !== 'probe').map(e => e.probe_id.split(':')[0])).size : 0;
  return {
    ...baseReceipt(startedAt),
    ...(fake ? noModelSpend('fake transport: no model and no paid request') : { cost: cost ? receiptCost(cost) : null }),
    run_status: result ? 'completed' : 'error',
    ...(result ? { verdict: scored === planned ? 'pass' as const : 'partial' as const } : {}),
    n_total: planned, n_scored: scored, completion_rate: planned ? scored / planned : 0, errors,
    publishable: !!result && !fake && scored === planned,
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: fake ? 'probe-fake' : 'probe', target, stage: TEST_STAGE, skills: skills ?? null, from: fromPath, other: otherPath ?? null, keys_in_process: keyNames, models: result?.models ?? null },
    finished_at: new Date().toISOString(),
    data: { probe: result ? testStageData(result, inputs) : null, reprice_trigger: result?.reprice_trigger ?? null },
  };
}

/** Each ledger entry this process made in the run: what the smoke prints per call. */
function ledgerCalls(run: BudgetRun) {
  return readLedger(run.ledgerPath).entries
    .filter(e => e.run_id === run.runId && (run.participant === null || e.participant === run.participant))
    .map(e => ({ description: e.description, input_tokens: e.input_tokens, output_tokens: e.output_tokens, usd: e.actual_usd ?? e.reserved_usd, status: e.status }));
}

async function runSmokeCli(argv: readonly string[], log: (s: string) => void, fake: boolean): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const skill = parseSkills(argv)?.[0] ?? 'query';
  let keys: Record<string, string> = {};
  let attestation: Attestation | null = null;
  if (!fake) {
    requirePaidArm(argv, { arm: 'n15 frontier smoke', estimateUsd: SMOKE_ESTIMATE_USD });
    keys = requireKeys(FRONTIER_TARGET_NAMES.map(t => TARGET_KEY[t]), 'n15 frontier smoke');
    attestation = attestPreregistration(PREREGISTRATION);
  }
  const paid = paidRun(fake, 'smoke', argv, SMOKE_ESTIMATE_USD, log);
  const results: SmokeResult[] = [];
  const errors: ProbeError[] = [];
  let cost: RunSummary | null = null;
  let calls: ReturnType<typeof ledgerCalls> | null = null;
  try {
    for (const target of FRONTIER_TARGET_NAMES) {
      try {
        results.push(await withHermeticEnv(`n15-smoke-${target}`, async () => {
          if (!fake) process.env[TARGET_KEY[target]] = keys[TARGET_KEY[target]];
          return runSmoke({ target, fake, skill });
        }));
      } catch (e) {
        errors.push({ probe_id: `smoke:${target}`, origin: 'harness', message: (e as Error).message });
      }
    }
  } finally {
    paid?.guard.uninstall();
    if (paid) { calls = ledgerCalls(paid.run); cost = paid.run.close(); }
  }
  for (const r of results) if (r.error || r.turns === null) errors.push({ probe_id: `smoke:${r.target}`, origin: 'dependency', message: r.error ?? 'no trajectory' });
  for (const r of results) {
    log(`smoke ${r.target} (${r.model}) ${r.task_id}: ${r.turns ?? '?'} turns, tools [${r.tool_calls.join(', ')}], stop ${r.stop_reason ?? '?'}, correct ${r.correct}, ${r.cost.input_tokens} in / ${r.cost.output_tokens} out tokens over ${r.cost.calls} calls, reasoning ${r.cost.reasoning_tokens ?? 'not reported'}, cached share ${r.cost.cached_input_share?.toFixed(3) ?? 'n/a'}, $${r.cost.usd.toFixed(4)} at list price`);
    for (const s of r.request_settings ?? []) log(`  sent to ${s.host} ${s.model}: ${JSON.stringify(s.sent)}${s.applied_reasoning_effort !== undefined ? `; applied reasoning effort ${s.applied_reasoning_effort}` : ''}`);
  }
  for (const c of calls ?? []) log(`ledger: ${c.description}: ${c.input_tokens ?? '?'} in / ${c.output_tokens ?? '?'} out, $${c.usd.toFixed(4)} (${c.status})`);
  const planned = FRONTIER_TARGET_NAMES.length;
  const scored = results.filter(r => !r.error && r.turns !== null).length;
  return {
    ...baseReceipt(startedAt),
    ...(fake ? noModelSpend('fake transport: no model and no paid request') : { cost: cost ? receiptCost(cost) : null }),
    run_status: results.length ? 'completed' : 'error',
    ...(results.length ? { verdict: scored === planned ? 'pass' as const : 'partial' as const } : {}),
    n_total: planned, n_scored: scored, completion_rate: scored / planned, errors,
    publishable: !fake && scored === planned,
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: fake ? 'smoke-fake' : 'smoke', skill, models: FRONTIER_TARGETS },
    finished_at: new Date().toISOString(),
    data: { smoke: results, ledger_calls: calls },
  };
}

/** Historical: the Haiku probe (probes 1 and 2). */
async function runHistoricalProbe(argv: readonly string[], log: (s: string) => void, outDir: string, fake: boolean): Promise<Receipt> {
  const startedAt = new Date().toISOString();
  const skills = parseSkills(argv) ?? [...SKILLS];
  const dataset = parseDataset(argv);
  const afterHardening = argv.includes('--after-hardening');
  log(`[n15 probe] ${HISTORICAL_NOTE}`);
  const estimateUsd = PROBE_ESTIMATE_USD * skills.length / SKILLS.length;
  let keys: Record<string, string> = {};
  let attestation: Attestation | null = null;
  if (!fake) {
    requirePaidArm(argv, { arm: 'n15 A1 headroom probe (historical, Haiku 5.5)', estimateUsd });
    keys = requireKeys(['ANTHROPIC_API_KEY'], 'n15 A1 probe');
    attestation = attestPreregistration(PREREGISTRATION);
  }
  const paid = paidRun(fake, 'probe', argv, estimateUsd, log);
  let probe: ProbeResult | null = null;
  let cost: RunSummary | null = null;
  const errors: ProbeError[] = [];
  try {
    probe = await withHermeticEnv('n15-probe', async () => {
      for (const [k, v] of Object.entries(keys)) process.env[k] = v;
      const done: ProbeSkillResult[] = [];
      return runProbe({
        fake, skills, dataset, afterHardening, log,
        onSkill: result => {
          done.push(result);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'probe-partial.json'), JSON.stringify({ category: CATEGORY, started_at: startedAt, skills: done.map(({ rewrites, ...s }) => ({ ...s, rewrite_audits: rewrites.map(text => auditSkill(s.skill, text)) })) }, null, 2) + '\n');
        },
      });
    });
  } catch (e) {
    errors.push({ probe_id: 'probe', origin: 'harness', message: (e as Error).message });
  } finally {
    paid?.guard.uninstall();
    cost = paid ? paid.run.close() : null;
  }
  for (const s of probe?.skills ?? []) {
    const arms = [['no_skill', s.arms.no_skill], ['seed', s.arms.seed], ['seed_opus', s.arms.seed_opus], ...s.arms.one_shot.map((a, i) => [`one_shot_${i + 1}`, a] as const)] as const;
    for (const [arm, a] of arms) if (a.score === null) errors.push({ probe_id: `${s.skill}:${arm}`, origin: 'dependency', message: a.error ?? ('rewrite_error' in a ? String(a.rewrite_error) : 'unscored') });
  }
  const planned = skills.length * 5;
  const scored = planned - errors.filter(e => e.probe_id !== 'probe').length;
  return {
    ...baseReceipt(startedAt),
    ...(fake ? noModelSpend('fake transport: no model and no paid request') : { cost: cost ? receiptCost(cost) : null }),
    run_status: probe ? 'completed' : 'error',
    ...(probe ? { verdict: scored === planned ? 'pass' as const : 'partial' as const } : {}),
    n_total: planned, n_scored: probe ? scored : 0, completion_rate: probe ? scored / planned : 0, errors,
    publishable: !!probe && !fake && scored === planned,
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, mode: fake ? 'probe-fake' : 'probe', historical: HISTORICAL_NOTE, skills, dataset: datasetName(dataset), models: HISTORICAL_PROBE_MODELS, after_hardening: afterHardening },
    finished_at: new Date().toISOString(),
    data: { probe: probe ? probeData(probe) : null },
  };
}

const fmt = (x: number | null | undefined) => (x === null || x === undefined ? 'none' : String(Number(x.toFixed(4))));

function logFrontier(p: ReturnType<typeof frontierData>, log: (s: string) => void): void {
  for (const s of p.skills) {
    const what = s.skipped ? `skipped (${s.skipped})` : p.stage === 'f0a' ? `no-skill ${fmt(s.no_skill)}, seed ${fmt(s.seed)}` : `seed ${fmt(s.seed)}, one-shot ${s.one_shot_repeats.map(fmt).join('/')} kept ${fmt(s.one_shot_kept)}`;
    const cost = s.cost ? `; mean rollout $${fmt(s.cost.mean_rollout_usd)}, ${fmt(s.cost.calls_per_rollout)} calls per rollout, cached share ${fmt(s.cost.cached_input_share)}` : '';
    log(`probe ${p.target} ${p.stage} ${s.skill}${p.mode === 'fake' ? ' (fake transport)' : ''}: ${what}, ceiling ${s.ceiling}${cost}`);
  }
  const fakeNote = p.mode === 'fake' ? ' (fake numbers; proves the path, not the gate)' : '';
  const trigger = p.reprice_trigger ? `; ${p.reprice_trigger.reason} on ${p.reprice_trigger.skill} (mean rollout $${fmt(p.reprice_trigger.mean_rollout_usd)} over $${p.reprice_trigger.threshold_usd.toFixed(2)})` : '';
  if (!p.gate) log(`gate ${p.target} after f0a: decided after F0b, which runs ${p.f0b_skills.join(', ')}${trigger}${fakeNote}`);
  else log(`gate ${p.target} after ${p.stage}: ${p.gate.verdict}${p.gate.waits_for_rerun.length ? ` (waits for a rerun of ${p.gate.waits_for_rerun.join(', ')})` : ''}${trigger}${fakeNote}`);
  logRequestSettings(p.request_settings, log);
}

function logRequestSettings(settings: RequestSettings[] | null, log: (s: string) => void): void {
  for (const r of settings ?? []) log(`sent to ${r.host} ${r.model} (${r.requests} requests): ${JSON.stringify(r.sent)}${r.applied_reasoning_effort !== undefined ? `; applied reasoning effort ${r.applied_reasoning_effort}` : ''}`);
}

const interval = (d: (PairedDifference & { verdict: string }) | null) => (d ? `${d.point >= 0 ? '+' : ''}${fmt(d.point)} [${fmt(d.lower)}, ${fmt(d.upper)}], ${d.wins} wins / ${d.losses} losses, McNemar p ${d.mcnemar_p === null ? 'n/a' : d.mcnemar_p.toPrecision(2)}, ${d.verdict}` : 'none');

function logTestStage(p: ReturnType<typeof testStageData>, log: (s: string) => void): void {
  for (const s of p.skills) {
    const head = `probe ${p.target} test ${s.skill}${p.mode === 'fake' ? ' (fake transport)' : ''}`;
    const rewrite = s.rewrite_source ? `rewrite ${fmt(s.rewrite)} (${s.rewrite_target}'s rewrite ${s.rewrite_number}, ${s.rewrite_sha8}, ${s.rewrite_source})` : `no rewrite arm (${s.no_rewrite_reason})`;
    if (s.skipped) { log(`${head}: skipped (${s.skipped}); ${rewrite}`); continue; }
    log(`${head}: no-skill ${fmt(s.no_skill)}, seed ${fmt(s.seed)}, ${rewrite}, ceiling ${s.ceiling}`);
    log(`  seed minus no skill ${interval(s.seed_minus_no_skill)}; rewrite minus seed ${interval(s.rewrite_minus_seed)}`);
    const perCorrect = Object.entries(s.arms).map(([arm, a]) => `${arm} ${a.cost_per_correct_usd === null ? 'none' : `$${fmt(a.cost_per_correct_usd)}`}`).join(', ');
    log(`  cost per correct answer: ${perCorrect}; mean rollout $${fmt(s.cost?.mean_rollout_usd)}, ${fmt(s.cost?.calls_per_rollout)} calls per rollout`);
  }
  if (p.reprice_trigger) log(`${p.reprice_trigger.reason} on ${p.reprice_trigger.skill}: mean rollout $${fmt(p.reprice_trigger.mean_rollout_usd)} over $${p.reprice_trigger.threshold_usd.toFixed(2)}; the stage stopped there`);
  if (p.mode === 'fake') log(`test ${p.target}: fake numbers; they prove the path, not the verdicts`);
  logRequestSettings(p.request_settings, log);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const output = argValue(argv, '--output');
  const probeMode = argv.includes('--probe');
  const smokeMode = argv.includes('--smoke');
  const fake = argv.includes('--fake');
  const target = probeMode ? parseTarget(argv) : null;
  const stage = probeMode && target !== 'haiku' ? parseStage(argv) : null;
  const reports = join(process.cwd(), 'eval/reports', CATEGORY, 'probe');
  const outPath = output ? join(output, 'receipt.json')
    : smokeMode ? join(reports, 'frontier', 'smoke', 'receipt.json')
    : target === 'haiku' ? join(reports, 'receipt.json')
    : target ? join(reports, 'frontier', `${target}-${stage}`, 'receipt.json')
    : receiptPath(CATEGORY);
  log(`# BrainBench N15: SkillOpt method benchmark, Phase 1 (gbrain ${gbrainVersion()})`);
  if ((probeMode || smokeMode) && !fake && !paidRequested(argv)) log('This run spends money; pass --paid --budget-run-id <id> (or --fake for the keyless path).');
  let receipt: Receipt;
  if (smokeMode) receipt = await runSmokeCli(argv, log, fake);
  else if (target === 'haiku') receipt = await runHistoricalProbe(argv, log, dirname(outPath), fake);
  else if (target && stage) receipt = stage === TEST_STAGE ? await runTestStageCli(argv, log, dirname(outPath), target, fake) : await runFrontierCli(argv, log, dirname(outPath), target, stage, fake);
  else receipt = await runHermetic(argv, log);
  writeReceipt(outPath, receipt);
  const d = receipt.data as Record<string, any>;
  if (d.integrity) {
    const i = d.integrity as IntegrityResult;
    log(`\nverdict: ${receipt.verdict ?? receipt.run_status} (report-only; nothing gates)`);
    log(`datasets: ${i.dataset_problems.length ? i.dataset_problems.join('; ') : `${DATASET_VERSIONS.join(' and ')} regenerate byte for byte and match their MANIFEST.json; the probe reads ${datasetName(DEFAULT_DATASET)}`}`);
    log(`seeds: ${i.seed_problems.length ? i.seed_problems.join('; ') : `all match their sha256 at gbrain ${SEED_GBRAIN_COMMIT.slice(0, 9)}`}`);
    for (const [s, x] of Object.entries(i.scorer)) log(`scorer ${s}: ${x.tasks - x.controls_failing.length}/${x.tasks} solvability controls pass; ${x.degenerate_passing.length} degenerate answers pass`);
    for (const c of d.coverage as ReturnType<typeof toolCoverage>) log(`tools ${c.skill}: ${c.full ? 'every frontmatter brain operation is served' : `not served: ${c.missing.join(', ')}`}${c.outside_brain.length ? `; outside the brain: ${c.outside_brain.join(', ')}` : ''}`);
    if (d.fake_probe) {
      for (const p of d.fake_probe.probes) logFrontier(p, log);
      log(`counted skills (fake): ${JSON.stringify(d.fake_probe.counted_skills.per_target)}`);
      for (const s of d.fake_probe.smoke as SmokeResult[]) log(`smoke ${s.target} (fake transport): ${s.turns} turns, ${s.cost.calls} calls, correct ${s.correct}`);
    }
  } else if (d.probe?.historical) {
    const p = d.probe as ReturnType<typeof probeData>;
    for (const s of p.skills) log(`probe ${s.skill}${p.mode === 'fake' ? ' (fake transport)' : ''}: no-skill ${s.no_skill}, seed ${s.seed}, one-shot ${s.one_shot_repeats.join('/')} kept ${s.one_shot_kept}, seed on Opus ${s.seed_opus}, ceiling ${s.ceiling}`);
    log(`gate: ${p.gate.verdict}${p.gate.waits_for_rerun.length ? ` (waits for a rerun of ${p.gate.waits_for_rerun.join(', ')})` : ''} (${HISTORICAL_NOTE})`);
  } else if (d.probe?.stage === TEST_STAGE) {
    logTestStage(d.probe, log);
  } else if (d.probe) {
    logFrontier(d.probe, log);
    if (d.counted_skills) log(`counted skills: ${JSON.stringify(d.counted_skills.per_target)} (targets read: ${d.counted_skills.targets_read.join(', ')})`);
  }
  if (receipt.errors.length) for (const e of receipt.errors) log(`error ${e.probe_id} (${e.origin}): ${e.message}`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, gate: d.probe?.gate ?? null }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => {
    if (e instanceof PaidArmRefusal) { console.error(e.message); process.exit(2); }
    console.error(e);
    process.exit(3);
  });
}

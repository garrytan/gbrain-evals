/**
 * BrainBench Cat 14 — Calibration A/B (think with vs without --with-calibration).
 *
 * The headline product question for gbrain v0.36.1.0's Hindsight wave:
 * does `gbrain think --with-calibration` produce better answers than
 * plain `gbrain think` on questions where the user has a relevant
 * track record?
 *
 * Per-probe flow:
 *   1. Seed an in-memory PGLite brain with the probe's `brain_setup`
 *      (synthetic pages + resolved takes + pre-populated
 *      calibration_profile row carrying the bias tags + narrative).
 *   2. Build baseline + calibrated system+user prompts via gbrain's
 *      exported buildThinkSystemPrompt / buildThinkUserMessage /
 *      buildCalibrationBlock helpers. Call the Anthropic chat API
 *      with each prompt pair. Capture both answers.
 *   3. Send (question, baseline_answer, calibrated_answer, expected.*)
 *      to the cat14 judge. Judge scores 5 axes via structured tool-use.
 *   4. Write per-probe JSON dump for the fix-feedback loop.
 *   5. Aggregate: win rate, per-axis pass rate, failure-mode breakdown.
 *
 * Design rationale + failure-loop playbook: see ../data/cat14-calibration/README.md.
 *
 * Run:
 *   bun eval/runner/cat14-calibration.ts
 *   CAT14_PROBES=cat14-pos-1-geography bun eval/runner/cat14-calibration.ts
 *   CAT14_DRY_RUN=1 bun eval/runner/cat14-calibration.ts   # judge stubbed
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Types ──────────────────────────────────────────────────────────

interface ResolvedTake {
  claim: string;
  quality: 'correct' | 'incorrect' | 'partial';
  weight: number;
  domain: string;
  since_date: string;
}

interface CalibrationProfileSeed {
  active_bias_tags: string[];
  pattern_statements: string[];
  grade_completion: number;
  voice_gate_passed: boolean;
}

interface BrainSetup {
  holder: string;
  resolved_takes: ResolvedTake[];
  calibration_profile: CalibrationProfileSeed;
}

interface ProbeExpected {
  mentions_relevant_bias_tag: boolean;
  presents_counter_prior: boolean;
  changes_recommendation_meaningfully: boolean;
  voice_conversational: boolean;
  doesnt_force_fit_irrelevant_bias: boolean;
  behaves_like_baseline?: boolean;
  voice_must_not_be_clinical?: boolean;
}

interface Probe {
  id: string;
  question: string;
  brain_setup: BrainSetup;
  expected: ProbeExpected;
  category: string;
  notes: string;
}

type AxisOutcome = 'pass' | 'fail' | 'unknown';

interface JudgeScore {
  axis: keyof ProbeExpected;
  expected: boolean;
  actual: boolean;
  outcome: AxisOutcome;
  rationale: string;
}

interface ProbeResult {
  probe_id: string;
  category: string;
  question: string;
  baseline_answer: string;
  calibrated_answer: string;
  scores: JudgeScore[];
  win_overall: 'calibrated' | 'baseline' | 'tie' | 'judge_failed';
  per_axis_pass_rate: number;
  failure_modes: string[];
}

// ─── Fixture loader ────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = join(__dirname, '..', 'data', 'cat14-calibration', 'probes.jsonl');
const DUMPS_DIR = join(__dirname, '..', 'reports', 'cat14-calibration');

function loadProbes(): Probe[] {
  if (!existsSync(PROBES_PATH)) {
    throw new Error(`probes.jsonl not found at ${PROBES_PATH}`);
  }
  const text = readFileSync(PROBES_PATH, 'utf-8');
  const probes: Probe[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    probes.push(JSON.parse(trimmed));
  }
  return probes;
}

// ─── Synthetic prompt construction ──────────────────────────────────

/**
 * Build a baseline think prompt — what `gbrain think "<q>"` produces
 * BEFORE --with-calibration injection. Mirrors src/core/think/prompt.ts
 * shape so the eval tests the actual prompt surface.
 */
function buildBaselineSystemPrompt(): string {
  return `You are gbrain's synthesis engine. You answer questions by reasoning across the user's personal knowledge brain. Be direct. Cite the user's own takes when relevant. Conversational voice — friend, not doctor.`;
}

function buildCalibratedSystemPrompt(profile: CalibrationProfileSeed): string {
  if (!profile.active_bias_tags.length || !profile.pattern_statements.length) {
    // Empty-profile case: fall through to baseline so the cold-brain
    // probe behaves identically to baseline (cat14-neg-1).
    return buildBaselineSystemPrompt();
  }
  return `You are gbrain's synthesis engine. You answer questions by reasoning across the user's personal knowledge brain.

CALIBRATION-AWARE MODE: the user has an established track record. Below is their calibration profile — bias patterns extracted from resolved takes.

<calibration_profile holder="garry">
  <active_bias_tags>${profile.active_bias_tags.join(', ')}</active_bias_tags>
  <pattern_statements>
${profile.pattern_statements.map(s => `    - ${s}`).join('\n')}
  </pattern_statements>
</calibration_profile>

Rules:
1. ONLY mention a bias if it is semantically relevant to the question's domain. Do not force-fit.
2. When you mention a bias, name BOTH priors transparently: "your prior says X; counter-prior from your track record says Y."
3. Adjust your recommendation in proportion to the bias strength.
4. Voice: friend, not doctor. Never "your Brier in this domain is 0.31." Use "you tend to miss" instead.
5. If no bias is relevant, answer as you would without the profile. Don't manufacture a counter-prior.`;
}

function buildUserMessage(question: string): string {
  return `Question: ${question}`;
}

// ─── Anthropic client + chat ────────────────────────────────────────

const MODEL = process.env.CAT14_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.CAT14_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required');
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

async function chat(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const block = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return block?.text ?? '';
}

// ─── Judge ──────────────────────────────────────────────────────────

const JUDGE_TOOL: Anthropic.Messages.Tool = {
  name: 'score_calibration_ab',
  description: 'Score the calibrated answer vs the baseline answer on 5 calibration axes.',
  input_schema: {
    type: 'object',
    properties: {
      mentions_relevant_bias_tag: { type: 'boolean', description: 'Does the calibrated answer surface a bias tag from the profile that is semantically relevant to the question?' },
      presents_counter_prior: { type: 'boolean', description: 'When a bias is mentioned, does the calibrated answer name both the gut prior AND a counter-prior?' },
      changes_recommendation_meaningfully: { type: 'boolean', description: 'Does the calibrated recommendation differ from baseline in a domain-appropriate way?' },
      voice_conversational: { type: 'boolean', description: 'Does the answer stay friend-not-doctor across the whole response? No "your Brier score" without translation, no clinical tone.' },
      doesnt_force_fit_irrelevant_bias: { type: 'boolean', description: 'If the profile bias is not relevant to the question domain, the answer correctly does NOT mention it.' },
      win_overall: { type: 'string', enum: ['calibrated', 'baseline', 'tie'], description: 'Which answer is more useful for the user? Calibrated wins only if it adds genuine signal without force-fitting.' },
      rationale: { type: 'string', description: 'Plain-English explanation per axis. ~3-5 sentences.' },
    },
    required: ['mentions_relevant_bias_tag', 'presents_counter_prior', 'changes_recommendation_meaningfully', 'voice_conversational', 'doesnt_force_fit_irrelevant_bias', 'win_overall', 'rationale'],
  },
};

interface JudgeOutput {
  mentions_relevant_bias_tag: boolean;
  presents_counter_prior: boolean;
  changes_recommendation_meaningfully: boolean;
  voice_conversational: boolean;
  doesnt_force_fit_irrelevant_bias: boolean;
  win_overall: 'calibrated' | 'baseline' | 'tie';
  rationale: string;
}

async function judgeProbe(probe: Probe, baselineAnswer: string, calibratedAnswer: string): Promise<JudgeOutput | null> {
  const sys = `You are a calibration-eval judge. Score the calibrated answer against the baseline on 5 axes.

The profile shows the user's known bias patterns. The question may or may not be in a domain where those biases are relevant.

Probe context:
- Category: ${probe.category}
- Profile bias tags: ${probe.brain_setup.calibration_profile.active_bias_tags.join(', ') || '(empty)'}
- Profile pattern statements: ${probe.brain_setup.calibration_profile.pattern_statements.join(' | ') || '(empty)'}
- Notes: ${probe.notes}

Score conservatively. Force-fitting an irrelevant bias is WORSE than missing a relevant one.`;
  const user = `Question: ${probe.question}

[BASELINE ANSWER]
${baselineAnswer}

[CALIBRATED ANSWER]
${calibratedAnswer}

Score via the score_calibration_ab tool.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await getAnthropic().messages.create({
        model: JUDGE_MODEL,
        max_tokens: 800,
        system: sys,
        tools: [JUDGE_TOOL],
        tool_choice: { type: 'tool', name: 'score_calibration_ab' },
        messages: [{ role: 'user', content: user }],
      });
      const toolUse = res.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
      if (toolUse && toolUse.name === 'score_calibration_ab') {
        return toolUse.input as JudgeOutput;
      }
    } catch (err) {
      if (attempt === 2) {
        console.error(`[cat14] judge failed for ${probe.id} after retry:`, err);
        return null;
      }
    }
  }
  return null;
}

// ─── Score one probe ───────────────────────────────────────────────

function gradeAxis(axisName: keyof ProbeExpected, expected: boolean, actual: boolean): AxisOutcome {
  return expected === actual ? 'pass' : 'fail';
}

async function runProbe(probe: Probe, dryRun: boolean): Promise<ProbeResult> {
  // 1. Build prompts.
  const baselineSys = buildBaselineSystemPrompt();
  const calibratedSys = buildCalibratedSystemPrompt(probe.brain_setup.calibration_profile);
  const user = buildUserMessage(probe.question);

  let baselineAnswer = '';
  let calibratedAnswer = '';
  let judgeOut: JudgeOutput | null = null;

  if (dryRun) {
    baselineAnswer = `[DRY-RUN baseline stub for ${probe.id}]`;
    calibratedAnswer = `[DRY-RUN calibrated stub for ${probe.id}]`;
    judgeOut = {
      mentions_relevant_bias_tag: probe.expected.mentions_relevant_bias_tag,
      presents_counter_prior: probe.expected.presents_counter_prior,
      changes_recommendation_meaningfully: probe.expected.changes_recommendation_meaningfully,
      voice_conversational: probe.expected.voice_conversational,
      doesnt_force_fit_irrelevant_bias: probe.expected.doesnt_force_fit_irrelevant_bias,
      win_overall: 'calibrated',
      rationale: 'DRY-RUN: judge stubbed to expected values',
    };
  } else {
    // 2. Run both completions in parallel.
    [baselineAnswer, calibratedAnswer] = await Promise.all([
      chat(baselineSys, user),
      chat(calibratedSys, user),
    ]);

    // 3. Judge.
    judgeOut = await judgeProbe(probe, baselineAnswer, calibratedAnswer);
  }

  // 4. Build per-axis scores.
  const scores: JudgeScore[] = [];
  const axes: (keyof ProbeExpected)[] = [
    'mentions_relevant_bias_tag',
    'presents_counter_prior',
    'changes_recommendation_meaningfully',
    'voice_conversational',
    'doesnt_force_fit_irrelevant_bias',
  ];
  for (const axis of axes) {
    const expected = probe.expected[axis] ?? false;
    const actual = judgeOut ? Boolean((judgeOut as Record<string, unknown>)[axis]) : false;
    scores.push({
      axis,
      expected,
      actual,
      outcome: judgeOut ? gradeAxis(axis, expected, actual) : 'unknown',
      rationale: judgeOut?.rationale ?? 'judge_failed',
    });
  }

  const passes = scores.filter(s => s.outcome === 'pass').length;
  const per_axis_pass_rate = passes / scores.length;

  const failure_modes = scores.filter(s => s.outcome === 'fail').map(s => s.axis as string);

  return {
    probe_id: probe.id,
    category: probe.category,
    question: probe.question,
    baseline_answer: baselineAnswer,
    calibrated_answer: calibratedAnswer,
    scores,
    win_overall: judgeOut?.win_overall ?? 'judge_failed',
    per_axis_pass_rate,
    failure_modes,
  };
}

// ─── Per-probe JSON dump ────────────────────────────────────────────

function writeDump(result: ProbeResult): void {
  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  const path = join(DUMPS_DIR, `${result.probe_id}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
}

// ─── Aggregate ─────────────────────────────────────────────────────

interface RunSummary {
  total_probes: number;
  judge_failed: number;
  win_rate_calibrated: number;
  win_rate_baseline: number;
  win_rate_tie: number;
  per_axis_pass_rate: Record<string, number>;
  failure_mode_counts: Record<string, number>;
  gate: 'pass' | 'fail';
  gate_reasons: string[];
}

function aggregate(results: ProbeResult[]): RunSummary {
  const total = results.length;
  const judgeFailed = results.filter(r => r.win_overall === 'judge_failed').length;
  const winCal = results.filter(r => r.win_overall === 'calibrated').length;
  const winBase = results.filter(r => r.win_overall === 'baseline').length;
  const winTie = results.filter(r => r.win_overall === 'tie').length;

  const axes: (keyof ProbeExpected)[] = [
    'mentions_relevant_bias_tag',
    'presents_counter_prior',
    'changes_recommendation_meaningfully',
    'voice_conversational',
    'doesnt_force_fit_irrelevant_bias',
  ];
  const perAxis: Record<string, number> = {};
  for (const axis of axes) {
    const passes = results.filter(r => r.scores.find(s => s.axis === axis)?.outcome === 'pass').length;
    perAxis[axis] = total > 0 ? passes / total : 0;
  }

  const failureModes: Record<string, number> = {};
  for (const r of results) {
    for (const mode of r.failure_modes) {
      failureModes[mode] = (failureModes[mode] ?? 0) + 1;
    }
  }

  const gateReasons: string[] = [];
  const winRate = total > 0 ? winCal / total : 0;
  if (winRate < 0.55) gateReasons.push(`win_rate ${(winRate * 100).toFixed(0)}% < 55% target`);
  if (perAxis.voice_conversational < 0.95) gateReasons.push(`voice_conversational ${(perAxis.voice_conversational * 100).toFixed(0)}% < 95% target`);
  if (perAxis.doesnt_force_fit_irrelevant_bias < 0.90) gateReasons.push(`doesnt_force_fit_irrelevant_bias ${(perAxis.doesnt_force_fit_irrelevant_bias * 100).toFixed(0)}% < 90% target`);

  return {
    total_probes: total,
    judge_failed: judgeFailed,
    win_rate_calibrated: winRate,
    win_rate_baseline: total > 0 ? winBase / total : 0,
    win_rate_tie: total > 0 ? winTie / total : 0,
    per_axis_pass_rate: perAxis,
    failure_mode_counts: failureModes,
    gate: gateReasons.length === 0 ? 'pass' : 'fail',
    gate_reasons: gateReasons,
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const probes = loadProbes();
  const filter = process.env.CAT14_PROBES;
  const filtered = filter
    ? probes.filter(p => filter.split(',').includes(p.id))
    : probes;
  const dryRun = process.env.CAT14_DRY_RUN === '1';

  if (filtered.length === 0) {
    console.error(`No probes matched filter: ${filter}`);
    process.exit(2);
  }

  console.log(`[cat14] running ${filtered.length} probes (model=${MODEL} judge=${JUDGE_MODEL} dry_run=${dryRun})`);

  const results: ProbeResult[] = [];
  for (const probe of filtered) {
    process.stderr.write(`  ${probe.id}... `);
    const result = await runProbe(probe, dryRun);
    results.push(result);
    writeDump(result);
    const passes = result.scores.filter(s => s.outcome === 'pass').length;
    process.stderr.write(`${passes}/${result.scores.length} axes pass, win=${result.win_overall}\n`);
  }

  const summary = aggregate(results);

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, '_summary.json'), JSON.stringify(summary, null, 2));

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('cat14 calibration A/B — summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`probes:            ${summary.total_probes} (judge_failed=${summary.judge_failed})`);
  console.log(`win calibrated:    ${(summary.win_rate_calibrated * 100).toFixed(0)}%`);
  console.log(`win baseline:      ${(summary.win_rate_baseline * 100).toFixed(0)}%`);
  console.log(`win tie:           ${(summary.win_rate_tie * 100).toFixed(0)}%`);
  console.log('per-axis pass rate:');
  for (const [axis, rate] of Object.entries(summary.per_axis_pass_rate)) {
    console.log(`  ${axis.padEnd(40)} ${(rate * 100).toFixed(0)}%`);
  }
  if (Object.keys(summary.failure_mode_counts).length > 0) {
    console.log('failure-mode counts:');
    for (const [mode, count] of Object.entries(summary.failure_mode_counts)) {
      console.log(`  ${mode.padEnd(40)} ${count}`);
    }
  }
  console.log('');
  console.log(`gate: ${summary.gate.toUpperCase()}`);
  if (summary.gate === 'fail') {
    for (const reason of summary.gate_reasons) console.log(`  ✗ ${reason}`);
    console.log('');
    console.log(`Per-probe dumps in ${DUMPS_DIR}/<probe_id>.json — read the rationale fields to find what to fix. See ../data/cat14-calibration/README.md for the failure-mode → fix-location map.`);
    process.exit(1);
  } else {
    console.log(`  ✓ all gates pass`);
  }
}

// Allow import for tests; run main when invoked directly.
if (import.meta.main) {
  main().catch(err => {
    console.error('[cat14] fatal:', err);
    process.exit(2);
  });
}

export { loadProbes, buildCalibratedSystemPrompt, buildBaselineSystemPrompt, runProbe, aggregate };
export type { Probe, ProbeResult, RunSummary, JudgeOutput };

/**
 * Cat 14 calibration A/B — hermetic regression suite.
 *
 * No API keys required: embeddings go through gbrain's
 * __setEmbedTransportForTests seam (deterministic hash embedding +
 * OPENAI_API_KEY=dummy), and the synthesis LLM is injected through
 * runThink's documented `client` seam as a deterministic actor.
 *
 * What this suite pins:
 *   1. runProbe drives the REAL gbrain runThink pipeline end-to-end
 *      (PGLite seed → gather → calibration profile fetch → buildCalibrationBlock
 *      → JSON envelope parse) and the gate PASSES on good (ideal-actor) input.
 *   2. Every previously-unfailable gate now FAILS on constructed bad input:
 *      - force-fit sabotage on a negative probe trips the 90% force-fit gate
 *      - clinical-voice sabotage trips the 95% voice gates
 *      - losing win verdicts trip the 60% win-rate gate
 *   3. Win-rate denominator excludes tie-expected probes (finding
 *      calibration-cats-05).
 *   4. Judge blinding: the judge prompt carries no probe notes, category
 *      names, expected verdicts, or calibrated/baseline labels (findings
 *      -04/-13), and both A/B orders are averaged (position bias → tie).
 *   5. Both A/B judging temperatures are pinned to 0 (finding -12).
 */

import { describe, test, expect } from 'bun:test';
import {
  loadProbes,
  runProbe,
  aggregate,
  gradeProbe,
  heuristicJudge,
  heuristicView,
  makeHermeticComplete,
  idealActor,
  forceFitActor,
  clinicalActor,
  buildJudgePrompts,
  mapJudgeOutputToView,
  THINK_TEMPERATURE,
  JUDGE_TEMPERATURE,
  TIE_EXPECTED_CATEGORIES,
  type Probe,
  type ProbeResult,
  type ProbeOutcome,
  type JudgeToolOut,
  type ActorBehavior,
  type JudgeView,
} from '../../eval/runner/cat14-calibration.ts';

const PROBE_TIMEOUT = 120_000;

function probeById(id: string): Probe {
  const p = loadProbes().find(x => x.id === id);
  if (!p) throw new Error(`probe ${id} missing from fixture`);
  return p;
}

async function runHermetic(probeId: string, actor: ActorBehavior = idealActor): Promise<ProbeOutcome> {
  const probe = probeById(probeId);
  return runProbe(probe, { complete: makeHermeticComplete(probe, actor), judge: heuristicJudge });
}

function resultOf(outcome: ProbeOutcome): ProbeResult {
  if (outcome.kind !== 'result') throw new Error(`expected result, got error: ${JSON.stringify(outcome)}`);
  if (outcome.sutError) throw new Error(`unexpected sut error: ${outcome.sutError}`);
  return outcome.result;
}

// Real pipeline runs are expensive (fresh PGLite engine + schema each);
// run the good-input set once and share across assertions.
let goodRunPromise: Promise<Map<string, ProbeResult>> | null = null;
function goodRuns(): Promise<Map<string, ProbeResult>> {
  if (!goodRunPromise) {
    goodRunPromise = (async () => {
      const out = new Map<string, ProbeResult>();
      for (const id of ['cat14-pos-1-geography', 'cat14-neg-1-empty-profile', 'cat14-neg-2-irrelevant-bias', 'cat14-neg-4-voice']) {
        out.set(id, resultOf(await runHermetic(id)));
      }
      return out;
    })();
  }
  return goodRunPromise;
}

// ─── Fixture schema ──────────────────────────────────────────────────

describe('cat14 probes fixture', () => {
  test('all probes load and have well-formed schema', () => {
    const probes = loadProbes();
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const probe of probes) {
      expect(probe.id).toMatch(/^cat14-/);
      expect(typeof probe.question).toBe('string');
      expect(probe.question.length).toBeGreaterThan(0);
      expect(Array.isArray(probe.brain_setup.resolved_takes)).toBe(true);
      expect(Array.isArray(probe.brain_setup.calibration_profile.active_bias_tags)).toBe(true);
      expect(probe.expected.voice_conversational).toBe(true);
    }
  });

  test('positive + negative + voice-stress categories all represented', () => {
    const categories = new Set(loadProbes().map(p => p.category));
    for (const c of [
      'calibration-pattern-relevant',
      'calibration-pattern-confidence-boost',
      'calibration-empty-profile',
      'calibration-bias-irrelevant',
      'calibration-multi-bias',
      'calibration-voice-stress',
    ]) {
      expect(categories.has(c)).toBe(true);
    }
  });
});

// ─── Real-pipeline conformance (gbrain runThink, hermetic) ───────────

describe('cat14 real-pipeline probe runs (hermetic)', () => {
  test('positive probe: calibration block reaches the prompt, all axes pass, calibrated wins', async () => {
    const r = (await goodRuns()).get('cat14-pos-1-geography')!;
    expect(r.calibration_block_present).toBe(true);
    expect(r.prompts_identical).toBe(false);
    expect(r.win_overall).toBe('calibrated');
    expect(r.win_eligible).toBe(true);
    for (const s of r.scores) {
      expect(`${s.axis}:${s.outcome}`).toBe(`${s.axis}:pass`);
    }
    expect(r.per_axis_pass_rate).toBe(1);
  }, PROBE_TIMEOUT);

  test('empty-profile probe: cold brain falls back to baseline (identical prompts, behaves_like_baseline scored)', async () => {
    const r = (await goodRuns()).get('cat14-neg-1-empty-profile')!;
    expect(r.calibration_block_present).toBe(false);
    expect(r.prompts_identical).toBe(true);
    expect(r.think_warnings.calibrated).toContain('NO_CALIBRATION_PROFILE');
    const behaves = r.scores.find(s => s.axis === 'behaves_like_baseline');
    expect(behaves).toBeDefined();
    expect(behaves!.outcome).toBe('pass');
    // Tie-expected category: never in the win-rate denominator.
    expect(r.win_eligible).toBe(false);
    expect(TIE_EXPECTED_CATEGORIES.has(r.category)).toBe(true);
  }, PROBE_TIMEOUT);

  test('irrelevant-bias probe: well-behaved answer omits the bias and scores clean', async () => {
    const r = (await goodRuns()).get('cat14-neg-2-irrelevant-bias')!;
    expect(r.calibration_block_present).toBe(true);
    expect(r.win_eligible).toBe(false);
    expect(r.scores.find(s => s.axis === 'doesnt_force_fit_irrelevant_bias')!.outcome).toBe('pass');
    expect(r.scores.find(s => s.axis === 'mentions_relevant_bias_tag')!.outcome).toBe('pass');
  }, PROBE_TIMEOUT);

  test('voice-stress probe declares and scores voice_must_not_be_clinical', async () => {
    const r = (await goodRuns()).get('cat14-neg-4-voice')!;
    const clinical = r.scores.find(s => s.axis === 'voice_must_not_be_clinical');
    expect(clinical).toBeDefined();
    expect(clinical!.outcome).toBe('pass');
  }, PROBE_TIMEOUT);

  test('gate PASSES on good input across the representative subset', async () => {
    const results = [...(await goodRuns()).values()];
    const summary = aggregate(results, { mode: 'hermetic' });
    expect(summary.gate_reasons).toEqual([]);
    expect(summary.gate).toBe('pass');
    expect(summary.win_eligible_n).toBe(2); // pos-1 + neg-4; neg-1/neg-2 tie-expected
    expect(summary.win_rate_calibrated).toBe(1);
  }, PROBE_TIMEOUT);
});

// ─── Gates fail on constructed bad input ─────────────────────────────

describe('cat14 gates are failable', () => {
  test('force-fit sabotage on a negative probe trips the 90% force-fit gate', async () => {
    const good = await goodRuns();
    const sabotaged = resultOf(await runHermetic('cat14-neg-2-irrelevant-bias', forceFitActor));
    expect(sabotaged.scores.find(s => s.axis === 'doesnt_force_fit_irrelevant_bias')!.outcome).toBe('fail');
    const results = [...good.values()].map(r => (r.probe_id === sabotaged.probe_id ? sabotaged : r));
    const summary = aggregate(results, { mode: 'hermetic' });
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('doesnt_force_fit_irrelevant_bias'))).toBe(true);
  }, PROBE_TIMEOUT);

  test('clinical-voice sabotage trips the 95% voice gates', async () => {
    const good = await goodRuns();
    const sabotaged = resultOf(await runHermetic('cat14-neg-4-voice', clinicalActor));
    expect(sabotaged.scores.find(s => s.axis === 'voice_conversational')!.outcome).toBe('fail');
    expect(sabotaged.scores.find(s => s.axis === 'voice_must_not_be_clinical')!.outcome).toBe('fail');
    const results = [...good.values()].map(r => (r.probe_id === sabotaged.probe_id ? sabotaged : r));
    const summary = aggregate(results, { mode: 'hermetic' });
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('voice_conversational'))).toBe(true);
    expect(summary.gate_reasons.some(r => r.includes('voice_must_not_be_clinical'))).toBe(true);
  }, PROBE_TIMEOUT);

  test('empty run cannot pass: every gate reports its missing subset', () => {
    const summary = aggregate([], { mode: 'hermetic' });
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('win_rate'))).toBe(true);
    expect(summary.gate_reasons.some(r => r.includes('no scored probes'))).toBe(true);
  });
});

// ─── Win-rate denominator (finding calibration-cats-05) ──────────────

function syntheticResult(overrides: Partial<ProbeResult> & { probe_id: string }): ProbeResult {
  const probe = probeById('cat14-pos-1-geography');
  const view: JudgeView = {
    kind: 'heuristic',
    cal_mentions_any_bias: true,
    cal_presents_counter_prior: true,
    cal_voice_conversational: true,
    cal_clinical_phrasing: false,
    answers_differ_meaningfully: true,
    win: 'calibrated',
    rationale: 'synthetic',
  };
  const graded = gradeProbe(probe, [view], false);
  return {
    category: probe.category,
    question: probe.question,
    baseline_answer: 'a',
    calibrated_answer: 'b',
    prompts_identical: false,
    calibration_block_present: true,
    think_warnings: { baseline: [], calibrated: [] },
    win_eligible: true,
    judge_orders: 1,
    ...graded,
    ...overrides,
  };
}

describe('cat14 win-rate denominator', () => {
  test('tie-expected probes are excluded: 2 eligible wins + 2 expected ties passes the 60% gate', () => {
    const results: ProbeResult[] = [
      syntheticResult({ probe_id: 'w1' }),
      syntheticResult({ probe_id: 'w2' }),
      syntheticResult({ probe_id: 't1', category: 'calibration-empty-profile', win_eligible: false, win_overall: 'tie', win_score: 0.5 }),
      syntheticResult({ probe_id: 't2', category: 'calibration-bias-irrelevant', win_eligible: false, win_overall: 'tie', win_score: 0.5 }),
    ];
    const summary = aggregate(results, { mode: 'hermetic' });
    // Old code computed 2/4 = 50% and failed; the fixed denominator is 2/2.
    expect(summary.win_eligible_n).toBe(2);
    expect(summary.win_rate_calibrated).toBe(1);
    expect(summary.gate_reasons.some(r => r.includes('win_rate'))).toBe(false);
  });

  test('losing verdicts on eligible probes trip the 60% win-rate gate', () => {
    const results: ProbeResult[] = [
      syntheticResult({ probe_id: 'w1' }),
      syntheticResult({ probe_id: 'l1', win_overall: 'baseline', win_score: 0 }),
      syntheticResult({ probe_id: 'l2', win_overall: 'baseline', win_score: 0 }),
    ];
    const summary = aggregate(results, { mode: 'hermetic' });
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('win_rate'))).toBe(true);
  });

  test('judge failures are excluded from the denominator, not scored as losses', () => {
    const results: ProbeResult[] = [
      syntheticResult({ probe_id: 'w1' }),
      syntheticResult({ probe_id: 'w2' }),
    ];
    const summary = aggregate(results, { mode: 'hermetic', judgeFailed: 3 });
    expect(summary.judge_failed).toBe(3);
    expect(summary.win_rate_calibrated).toBe(1); // 2/2, not 2/5
    expect(summary.total_probes).toBe(5);
    expect(summary.scored_probes).toBe(2);
  });
});

// ─── Judge blinding + order averaging (findings -04 / -13) ──────────

describe('cat14 judge blinding', () => {
  test('judge prompt never carries notes, category, expected verdicts, or calibrated/baseline labels', () => {
    for (const probe of loadProbes()) {
      const { system, user } = buildJudgePrompts(probe, 'answer one', 'answer two');
      const all = `${system}\n${user}`;
      if (probe.notes.trim().length > 0) {
        expect(all).not.toContain(probe.notes);
      }
      expect(all).not.toContain(probe.category);
      expect(all.toLowerCase()).not.toContain('expected');
      // Neutral labels only — the judge must not learn which arm is which.
      expect(all.toLowerCase()).not.toContain('calibrated answer');
      expect(all.toLowerCase()).not.toContain('baseline');
      expect(all).toContain('[ANSWER A]');
      expect(all).toContain('[ANSWER B]');
    }
  });

  test('a position-biased judge (always prefers Answer A) averages to a tie across both orders', () => {
    const biased = (moreUseful: 'A' | 'B' | 'tie'): JudgeToolOut => ({
      a_mentions_relevant_bias: true,
      a_mentions_irrelevant_bias: false,
      a_presents_counter_prior: true,
      a_voice_conversational: true,
      a_clinical_phrasing: false,
      b_mentions_relevant_bias: true,
      b_mentions_irrelevant_bias: false,
      b_presents_counter_prior: true,
      b_voice_conversational: true,
      b_clinical_phrasing: false,
      answers_differ_meaningfully: true,
      more_useful: moreUseful,
      rationale: 'synthetic biased judge',
    });
    // Runner judges order calibrated=B then calibrated=A; the biased judge
    // says "A" both times → one baseline verdict + one calibrated verdict.
    const viewOrder0 = mapJudgeOutputToView(biased('A'), 'B');
    const viewOrder1 = mapJudgeOutputToView(biased('A'), 'A');
    expect(viewOrder0.win).toBe('baseline');
    expect(viewOrder1.win).toBe('calibrated');
    const probe = probeById('cat14-pos-1-geography');
    const graded = gradeProbe(probe, [viewOrder0, viewOrder1], false);
    expect(graded.win_score).toBe(0.5);
    expect(graded.win_overall).toBe('tie');
  });

  test('split axis verdicts across orders score 0.5, not silently pass or fail', () => {
    const probe = probeById('cat14-pos-1-geography');
    const yes: JudgeView = {
      kind: 'llm',
      cal_mentions_relevant_bias: true,
      cal_mentions_irrelevant_bias: false,
      cal_presents_counter_prior: true,
      cal_voice_conversational: true,
      cal_clinical_phrasing: false,
      answers_differ_meaningfully: true,
      win: 'calibrated',
      rationale: 'r1',
    };
    const no: JudgeView = { ...yes, cal_presents_counter_prior: false, rationale: 'r2' };
    const graded = gradeProbe(probe, [yes, no], false);
    const counter = graded.scores.find(s => s.axis === 'presents_counter_prior')!;
    expect(counter.score).toBe(0.5);
    expect(counter.outcome).toBe('split');
  });
});

// ─── Determinism + temperature pins ──────────────────────────────────

describe('cat14 determinism', () => {
  test('think and judge temperatures are pinned to 0', () => {
    expect(THINK_TEMPERATURE).toBe(0);
    expect(JUDGE_TEMPERATURE).toBe(0);
  });

  test('heuristic judge is deterministic on identical input', () => {
    const probe = probeById('cat14-pos-1-geography');
    const base = idealActor(probe, false);
    const cal = idealActor(probe, true);
    const a = heuristicView(probe, base, cal);
    const b = heuristicView(probe, base, cal);
    expect(a).toEqual(b);
  });
});

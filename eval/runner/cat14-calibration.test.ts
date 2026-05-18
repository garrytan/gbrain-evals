/**
 * Cat 14 calibration A/B — hermetic smoke test.
 *
 * Runs the full runner with CAT14_DRY_RUN=1 so the judge is stubbed and
 * no API calls fire. Verifies:
 *   - fixture loads
 *   - all 8 probes have well-formed brain_setup + expected fields
 *   - the calibrated system-prompt builder honors empty-profile case
 *     (cat14-neg-1 must produce a baseline-shaped prompt)
 *   - aggregate gate logic catches the documented failure modes
 *
 * No API key required.
 */

import { describe, test, expect } from 'bun:test';
import { loadProbes, buildCalibratedSystemPrompt, buildBaselineSystemPrompt, aggregate } from './cat14-calibration.ts';
import type { ProbeResult } from './cat14-calibration.ts';

describe('cat14-calibration probes', () => {
  test('all probes load and have well-formed schema', () => {
    const probes = loadProbes();
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const probe of probes) {
      expect(probe.id).toMatch(/^cat14-/);
      expect(typeof probe.question).toBe('string');
      expect(probe.question.length).toBeGreaterThan(0);
      expect(probe.brain_setup).toBeDefined();
      expect(Array.isArray(probe.brain_setup.resolved_takes)).toBe(true);
      expect(probe.brain_setup.calibration_profile).toBeDefined();
      expect(Array.isArray(probe.brain_setup.calibration_profile.active_bias_tags)).toBe(true);
      expect(probe.expected.voice_conversational).toBe(true);
    }
  });

  test('positive + negative + voice-stress categories all represented', () => {
    const probes = loadProbes();
    const categories = new Set(probes.map(p => p.category));
    expect(categories.has('calibration-pattern-relevant')).toBe(true);
    expect(categories.has('calibration-pattern-confidence-boost')).toBe(true);
    expect(categories.has('calibration-empty-profile')).toBe(true);
    expect(categories.has('calibration-bias-irrelevant')).toBe(true);
    expect(categories.has('calibration-multi-bias')).toBe(true);
    expect(categories.has('calibration-voice-stress')).toBe(true);
  });

  test('empty-profile probe produces baseline-shaped prompt (cold-brain regression guard)', () => {
    const probes = loadProbes();
    const emptyProbe = probes.find(p => p.id === 'cat14-neg-1-empty-profile');
    expect(emptyProbe).toBeDefined();
    const sys = buildCalibratedSystemPrompt(emptyProbe!.brain_setup.calibration_profile);
    // Empty-profile path must NOT inject the <calibration_profile> block.
    expect(sys).not.toContain('<calibration_profile');
    // And must equal the baseline prompt verbatim.
    expect(sys).toBe(buildBaselineSystemPrompt());
  });

  test('non-empty profile produces a calibration block with bias tags + pattern statements', () => {
    const probes = loadProbes();
    const geo = probes.find(p => p.id === 'cat14-pos-1-geography');
    expect(geo).toBeDefined();
    const sys = buildCalibratedSystemPrompt(geo!.brain_setup.calibration_profile);
    expect(sys).toContain('<calibration_profile');
    expect(sys).toContain('over-confident-geography');
    expect(sys).toContain('Geography is your blind spot');
    expect(sys.toLowerCase()).toContain('force-fit');
    expect(sys).toMatch(/only mention a bias/i);
  });
});

describe('cat14-calibration gate logic', () => {
  function makeResult(overrides: Partial<ProbeResult>): ProbeResult {
    return {
      probe_id: overrides.probe_id ?? 'test-probe',
      category: overrides.category ?? 'calibration-pattern-relevant',
      question: 'Q?',
      baseline_answer: 'A',
      calibrated_answer: 'B',
      scores: overrides.scores ?? [
        { axis: 'mentions_relevant_bias_tag', expected: true, actual: true, outcome: 'pass', rationale: '' },
        { axis: 'presents_counter_prior', expected: true, actual: true, outcome: 'pass', rationale: '' },
        { axis: 'changes_recommendation_meaningfully', expected: true, actual: true, outcome: 'pass', rationale: '' },
        { axis: 'voice_conversational', expected: true, actual: true, outcome: 'pass', rationale: '' },
        { axis: 'doesnt_force_fit_irrelevant_bias', expected: true, actual: true, outcome: 'pass', rationale: '' },
      ],
      win_overall: overrides.win_overall ?? 'calibrated',
      per_axis_pass_rate: overrides.per_axis_pass_rate ?? 1,
      failure_modes: overrides.failure_modes ?? [],
    };
  }

  test('all-pass run produces gate=pass', () => {
    const results = [makeResult({}), makeResult({})];
    const summary = aggregate(results);
    expect(summary.gate).toBe('pass');
    expect(summary.gate_reasons).toEqual([]);
    expect(summary.win_rate_calibrated).toBe(1);
  });

  test('low win-rate trips the 55% gate', () => {
    const results = [
      makeResult({ probe_id: 'p1', win_overall: 'calibrated' }),
      makeResult({ probe_id: 'p2', win_overall: 'baseline' }),
      makeResult({ probe_id: 'p3', win_overall: 'baseline' }),
    ];
    const summary = aggregate(results);
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('win_rate'))).toBe(true);
  });

  test('voice axis failure trips the 95% gate even if win-rate is fine', () => {
    const results = [
      makeResult({
        probe_id: 'p1',
        win_overall: 'calibrated',
        scores: [
          { axis: 'mentions_relevant_bias_tag', expected: true, actual: true, outcome: 'pass', rationale: '' },
          { axis: 'presents_counter_prior', expected: true, actual: true, outcome: 'pass', rationale: '' },
          { axis: 'changes_recommendation_meaningfully', expected: true, actual: true, outcome: 'pass', rationale: '' },
          { axis: 'voice_conversational', expected: true, actual: false, outcome: 'fail', rationale: 'leaked Brier-score talk' },
          { axis: 'doesnt_force_fit_irrelevant_bias', expected: true, actual: true, outcome: 'pass', rationale: '' },
        ],
        failure_modes: ['voice_conversational'],
      }),
    ];
    const summary = aggregate(results);
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('voice_conversational'))).toBe(true);
  });

  test('force-fit failure on a negative probe trips the 90% gate', () => {
    const results = [
      makeResult({
        probe_id: 'p1',
        win_overall: 'calibrated',
        scores: [
          { axis: 'mentions_relevant_bias_tag', expected: false, actual: true, outcome: 'fail', rationale: 'fabricated bias mention' },
          { axis: 'presents_counter_prior', expected: false, actual: false, outcome: 'pass', rationale: '' },
          { axis: 'changes_recommendation_meaningfully', expected: false, actual: false, outcome: 'pass', rationale: '' },
          { axis: 'voice_conversational', expected: true, actual: true, outcome: 'pass', rationale: '' },
          { axis: 'doesnt_force_fit_irrelevant_bias', expected: true, actual: false, outcome: 'fail', rationale: 'shoehorned geography into AI tech question' },
        ],
        failure_modes: ['doesnt_force_fit_irrelevant_bias', 'mentions_relevant_bias_tag'],
      }),
    ];
    const summary = aggregate(results);
    expect(summary.gate).toBe('fail');
    expect(summary.gate_reasons.some(r => r.includes('doesnt_force_fit_irrelevant_bias'))).toBe(true);
  });
});

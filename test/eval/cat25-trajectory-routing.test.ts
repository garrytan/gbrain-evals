/**
 * Cat 25 trajectory routing A/B — hermetic regression suite.
 *
 * No API keys required: embeddings go through gbrain's
 * __setEmbedTransportForTests seam (deterministic hash embedding +
 * OPENAI_API_KEY=dummy), and the synthesis LLM is injected through
 * runThink's documented `client` seam as a deterministic actor.
 *
 * What this suite pins:
 *   1. GOOD INPUT: runProbe drives the REAL gbrain runThink pipeline
 *      end-to-end (PGLite seed via engine.insertFact → gather →
 *      classifyIntent → findTrajectory → <trajectory> block injection →
 *      synthesis) and the wave arm consumes trajectory data the baseline
 *      arm never sees.
 *   2. The previously-unfailable gates now FAIL on constructed bad input:
 *      - the ORIGINAL bug (facts seeded as a bare markdown table that never
 *        reaches the facts table, audit finding cats22-25-01) is caught by
 *        the preflight and aborts instead of publishing a same-vs-same A/B;
 *      - a broken trajectory wire (think.trajectory_enabled kill switch as
 *        a stand-in for a routing regression) becomes a 'sut' failure;
 *      - aggregate gates fail when the wave arm loses or the arms show no
 *        contrast (negative control).
 *   3. Judge failures become 'judge'-origin probe errors (excluded +
 *      capped), never scored 0 into the A/B means (finding cats22-25-02).
 */

import { describe, test, expect } from 'bun:test';
import {
  PROBES,
  runProbe,
  aggregate,
  hermeticComplete,
  markerJudge,
  legacyFactsTable,
  seedProbeEngine,
  preflightTrajectoryPoints,
  WAVE_MEAN_MIN_HERMETIC,
  type Probe,
  type ProbeResult,
  type ProbeOutcome,
  type ArmJudgeFn,
} from '../../eval/runner/cat25-trajectory-routing.ts';

const PROBE_TIMEOUT = 180_000;

function probeById(id: string): Probe {
  const p = PROBES.find(x => x.id === id);
  if (!p) throw new Error(`probe ${id} missing from fixture`);
  return p;
}

function resultOf(outcome: ProbeOutcome): ProbeResult {
  if (outcome.kind !== 'result') throw new Error(`expected result, got: ${JSON.stringify(outcome)}`);
  if (outcome.sutError) throw new Error(`unexpected sut error: ${outcome.sutError}`);
  return outcome.result;
}

describe('cat25 fixtures', () => {
  test('has the 6 probes the header promises, each with typed-claim rows', () => {
    expect(PROBES.length).toBe(6);
    for (const p of PROBES) {
      expect(p.facts.length).toBeGreaterThan(0);
      for (const g of p.facts) {
        expect(g.rows.length).toBeGreaterThan(1); // a trajectory needs >1 point
        for (const r of g.rows) {
          expect(r.metric.length).toBeGreaterThan(0);
          expect(Number.isFinite(r.value)).toBe(true);
          expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
      expect(p.gold_markers.length).toBeGreaterThan(0);
    }
  });
});

describe('cat25 good input — real pipeline, wave consumes trajectory', () => {
  test('wave arm injects the trajectory block; baseline arm never sees it', async () => {
    const probe = probeById('arr-trajectory-acme');
    const r = resultOf(await runProbe(probe, { complete: hermeticComplete, judge: markerJudge }));
    expect(r.trajectory_points_preflight).toBeGreaterThan(0);
    expect(r.wave_trajectory_injected).toBe(true);
    expect(r.wave_injected_points).toBeGreaterThan(0);
    expect(r.baseline_block_absent).toBe(true);
    expect(r.think_warnings.wave.some(w => /^TRAJECTORY_INJECTED_\d+_POINTS$/.test(w))).toBe(true);
    expect(r.think_warnings.baseline.some(w => /^TRAJECTORY_INJECTED_/.test(w))).toBe(false);
    // The deterministic actor answers from the injected block only: full
    // marks on wave, zero on baseline (negative-control contrast).
    expect(r.wave_score).toBe(1);
    expect(r.baseline_score).toBe(0);
  }, PROBE_TIMEOUT);

  test('two-entity probe still routes and scores via the asked entity markers', async () => {
    const probe = probeById('arr-two-entities-vector-vs-helix');
    const r = resultOf(await runProbe(probe, { complete: hermeticComplete, judge: markerJudge }));
    expect(r.wave_trajectory_injected).toBe(true);
    expect(r.wave_score).toBe(1);
    expect(r.wave_answer).toContain('$900K');
  }, PROBE_TIMEOUT);
});

describe('cat25 regression — the original bug can no longer publish', () => {
  test('legacy markdown-table seeding (no insertFact) fails the preflight', async () => {
    // Exactly the pre-fix seeding path: a bare '## Facts' markdown table in
    // the page body. parseFactsFence ignores it (no fence markers, wrong
    // columns) and importFromContent never writes the facts table, so
    // findTrajectory sees 0 points. The old runner ran the A/B anyway;
    // the new one must refuse.
    const probe = probeById('arr-trajectory-acme');
    const outcome = await runProbe(probe, {
      complete: hermeticComplete,
      judge: markerJudge,
      seed: { seedFactsViaInsert: false },
    });
    expect(outcome.kind).toBe('preflight_failed');
    if (outcome.kind === 'preflight_failed') {
      expect(outcome.message).toContain('0 points');
    }
  }, PROBE_TIMEOUT);

  test('legacyFactsTable renders the exact pre-fix shape (fence-less, 6 columns)', () => {
    const table = legacyFactsTable(probeById('arr-trajectory-acme').facts[0]!.rows);
    expect(table).toContain('## Facts');
    expect(table).toContain('| since | claim | metric | value | unit | period |');
    expect(table).not.toContain('gbrain:facts:begin');
  });

  test('preflight sees points through the same API runThink uses', async () => {
    const probe = probeById('team-size-trajectory-foundry');
    const engine = await seedProbeEngine(probe);
    try {
      const points = await preflightTrajectoryPoints(engine, probe);
      expect(points).toBe(probe.facts[0]!.rows.length);
    } finally {
      await engine.disconnect().catch(() => {});
    }
  }, PROBE_TIMEOUT);
});

describe('cat25 regression — broken routing becomes a sut failure', () => {
  test('trajectory kill switch on → wave arm cannot inject → sut error', async () => {
    // think.trajectory_enabled=false makes runThink skip injection even with
    // withTrajectory:true — a stand-in for any routing regression. The probe
    // must be scored as a SUT failure (0 in the means), never pass silently.
    const probe = probeById('arr-trajectory-acme');
    const outcome = await runProbe(probe, {
      complete: hermeticComplete,
      judge: markerJudge,
      seed: {
        configureEngine: async engine => {
          await engine.setConfig('think.trajectory_enabled', 'false');
        },
      },
    });
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.sutError).toBeDefined();
      expect(outcome.sutError).toContain('did not inject');
      expect(outcome.result.sut_failed).toBe(true);
      expect(outcome.result.wave_score).toBe(0);
    }
  }, PROBE_TIMEOUT);
});

describe('cat25 judge failures are typed errors, not zeros', () => {
  test('judge_failed → judge-origin probe error, probe excluded from results', async () => {
    const failingJudge: ArmJudgeFn = async () => ({ judge_failed: 'stub judge outage' });
    const probe = probeById('arr-trajectory-acme');
    const outcome = await runProbe(probe, { complete: hermeticComplete, judge: failingJudge });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.origin).toBe('judge');
      expect(outcome.message).toContain('stub judge outage');
    }
  }, PROBE_TIMEOUT);
});

describe('cat25 aggregate gates are failable', () => {
  const row = (over: Partial<ProbeResult>): ProbeResult => ({
    probe_id: 'p',
    question: 'q',
    trajectory_points_preflight: 3,
    baseline_answer: '',
    wave_answer: '',
    baseline_score: 0,
    wave_score: 1,
    delta: 1,
    wave_trajectory_injected: true,
    wave_injected_points: 3,
    baseline_block_absent: true,
    think_warnings: { baseline: [], wave: [] },
    model_used: { baseline: 'm', wave: 'm' },
    judge_detail: { baseline: '', wave: '' },
    ...over,
  });

  test('passes on good hermetic results', () => {
    const s = aggregate([row({}), row({ probe_id: 'p2' })], 'hermetic', 2);
    expect(s.gate).toBe('pass');
    expect(s.wave_mean).toBeGreaterThanOrEqual(WAVE_MEAN_MIN_HERMETIC);
  });

  test('fails when trajectory was not injected on a scored probe', () => {
    const s = aggregate([row({}), row({ wave_trajectory_injected: false, wave_score: 0, sut_failed: true })], 'hermetic', 2);
    expect(s.gate).toBe('fail');
    expect(s.gate_reasons.join(' ')).toContain('trajectory injected');
  });

  test('fails the negative control when the arms show no contrast', () => {
    // Both arms score 1.0 — the exact symptom of the original same-vs-same
    // bug (identical prompts). The hermetic gate must refuse to pass.
    const s = aggregate(
      [row({ baseline_score: 1, delta: 0 }), row({ probe_id: 'p2', baseline_score: 1, delta: 0 })],
      'hermetic', 2,
    );
    expect(s.gate).toBe('fail');
    expect(s.gate_reasons.join(' ')).toContain('negative control');
  });

  test('fails when the wave arm loses to baseline', () => {
    const s = aggregate(
      [row({ baseline_score: 1, wave_score: 0.5, delta: -0.5 })],
      'live', 1,
    );
    expect(s.gate).toBe('fail');
    expect(s.gate_reasons.join(' ')).toContain('loses');
  });

  test('fails on zero scored probes', () => {
    const s = aggregate([], 'hermetic', 6);
    expect(s.gate).toBe('fail');
  });
});

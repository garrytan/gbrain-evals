/**
 * Keyless decision test suite for the evidence-delivery decision manifest
 * (plan amendment 1): close wins, zero and negative gaps, sparse categories,
 * judge disagreement, selection among many policies and failed provider calls.
 */
import { describe, expect, test } from 'bun:test';
import {
  decideConfirmatory, decideE2, gpt4oSecondArm, loadDecisionManifest, selectPilot, validateDecisionManifest,
  type ArmRows, type DecisionManifest, type OutcomeRow,
} from '../../eval/runner/evidence-delivery/decision.ts';

const { manifest } = loadDecisionManifest();
const STRATA = manifest.data.strata;
/** 400 confirmatory-shaped questions with the real stratum sizes. */
const SIZES: Record<string, number> = { 'single-session-user': 54, 'single-session-assistant': 44, 'single-session-preference': 25, 'multi-session': 112, 'temporal-reasoning': 110, 'knowledge-update': 55 };
const QUESTIONS = Object.entries(SIZES).flatMap(([type, n]) => Array.from({ length: n }, (_, i) => ({ id: `${type}-${i}`, type })));
const IDS = QUESTIONS.map(q => q.id);

type Outcome = (index: number, type: string) => 0 | 1;
function arm(outcome: Outcome, tokens: number, extra: (i: number) => Partial<OutcomeRow> = () => ({}), confirmation?: Outcome): OutcomeRow[] {
  return QUESTIONS.map((q, i) => ({ question_id: q.id, question_type: q.type, cluster: q.id, primary: outcome(i, q.type), confirmation: (confirmation ?? outcome)(i, q.type), provider_input_tokens: tokens, ...extra(i) }));
}
/** chunk correct on [0, c), page correct on [0, p); a candidate correct on [0, w) plus optional losses at the start. */
const upTo = (k: number): Outcome => i => (i < k ? 1 : 0);
const withLosses = (k: number, lossIds: Set<number>): Outcome => i => (i < k && !lossIds.has(i) ? 1 : 0);

function base(chunk = 260, page = 360): ArmRows {
  return { chunk: arm(upTo(chunk), 3400), page: arm(upTo(page), 15500) };
}

describe('manifest', () => {
  test('the committed manifest is internally consistent', () => {
    expect(validateDecisionManifest(manifest)).toEqual([]);
    expect(manifest.family.holm_m).toBe(6);
    expect(manifest.candidate_commits.gbrain === null || /^[0-9a-f]{40}$/.test(manifest.candidate_commits.gbrain)).toBe(true);
  });

  test('validation catches a k10 candidate and a shrunken Holm family', () => {
    const bad: DecisionManifest = JSON.parse(JSON.stringify(manifest));
    bad.arms.find(a => a.id === 'k10')!.role = 'candidate';
    bad.family.holm_m = 2;
    const problems = validateDecisionManifest(bad);
    expect(problems.join('\n')).toContain('k10 must be a comparator');
    expect(problems.join('\n')).toContain('holm_m');
  });
});

describe('confirmatory: close wins and the closure hurdle', () => {
  test('a candidate exactly at chunk + 0.6 x gap passes; one question fewer fails on closure only', () => {
    const at = { ...base(), window1: arm(upTo(320), 6000) };
    const d = decideConfirmatory(manifest, at, IDS, ['window1']);
    expect(d.gap).toMatchObject({ value: 100, established: true });
    expect(d.candidates[0]).toMatchObject({ hurdle: 320, closure_met: true, token_met: true, significance_met: true, per_type_met: true, success: true });
    expect(d.outcome).toBe('success');
    expect(d.winner).toBe('window1');
    expect(d.candidates[0].closure_ratio).toBeCloseTo(0.6, 12);

    const below = { ...base(), window1: arm(upTo(319), 6000) };
    const e = decideConfirmatory(manifest, below, IDS, ['window1']);
    expect(e.candidates[0].closure_met).toBe(false);
    expect(e.candidates[0].significance_met).toBe(true);
    expect(e.outcome).toBe('page_only');
    expect(e.candidates[0].reasons[0]).toContain('below the hurdle 320.0');
  });

  test('the token rule is a point estimate against page on the same questions', () => {
    const pass = decideConfirmatory(manifest, { ...base(), auto6k: arm(upTo(340), 7750) }, IDS, ['auto6k']);
    expect(pass.candidates[0].token_ratio).toBeCloseTo(0.5, 12);
    expect(pass.outcome).toBe('success');
    const fail = decideConfirmatory(manifest, { ...base(), auto6k: arm(upTo(340), 7751) }, IDS, ['auto6k']);
    expect(fail.candidates[0].token_met).toBe(false);
    expect(fail.outcome).toBe('page_only');
  });

  test('significance needs a positive delta and Holm over all six candidates, untested ones at p = 1', () => {
    // 12 wins, 2 losses: exact McNemar p = 0.013, which passes alone but not after x6.
    const losses = new Set([0, 1]);
    const rows = { ...base(260, 262), window2: arm(withLosses(272, losses), 5000) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window2']);
    const c = d.candidates[0];
    expect(c.mcnemar.wins).toBe(12);
    expect(c.mcnemar.losses).toBe(2);
    expect(c.mcnemar.p).toBeLessThan(0.05);
    expect(c.mcnemar.p_holm).toBeCloseTo(Math.min(1, c.mcnemar.p * 6), 12);
    expect(c.significance_met).toBe(false);
  });
});

describe('confirmatory: zero and negative gaps', () => {
  test('page equal to chunk: no demonstrated benefit and no closure ratio', () => {
    const d = decideConfirmatory(manifest, { ...base(300, 300), section: arm(upTo(330), 5000) }, IDS, ['section']);
    expect(d.outcome).toBe('no_demonstrated_benefit');
    expect(d.gap.established).toBe(false);
    expect(d.candidates[0].closure_ratio).toBeNull();
    expect(d.winner).toBeNull();
  });

  test('page below chunk: no demonstrated benefit even when a candidate beats chunk', () => {
    const d = decideConfirmatory(manifest, { ...base(300, 290), section: arm(upTo(340), 5000) }, IDS, ['section']);
    expect(d.gap.value).toBe(-10);
    expect(d.outcome).toBe('no_demonstrated_benefit');
  });

  test('a small positive gap that is not significant is not established', () => {
    const d = decideConfirmatory(manifest, { ...base(300, 303), section: arm(upTo(303), 5000) }, IDS, ['section']);
    expect(d.gap.value).toBe(3);
    expect(d.gap.mcnemar_p).toBeGreaterThan(0.05);
    expect(d.outcome).toBe('no_demonstrated_benefit');
  });
});

describe('confirmatory: sparse categories', () => {
  test('a net loss of 3 in the 25-question preference stratum fails the per-type rule despite a large overall win', () => {
    const prefStart = QUESTIONS.findIndex(q => q.type === 'single-session-preference');
    const chunkRight = new Set([prefStart, prefStart + 1, prefStart + 2]);
    const chunk: Outcome = i => (i < 200 || chunkRight.has(i) ? 1 : 0);
    const cand: Outcome = i => (chunkRight.has(i) ? 0 : i < 330 ? 1 : 0);
    const rows = { chunk: arm(chunk, 3400), page: arm(i => (i < 360 || chunkRight.has(i) ? 1 : 0), 15500), auto4k: arm(cand, 4500) };
    const d = decideConfirmatory(manifest, rows, IDS, ['auto4k']);
    const pref = d.candidates[0].per_type.find(t => t.type === 'single-session-preference')!;
    expect(pref).toMatchObject({ n: 25, losses: 3, net_loss: 3, ok: false });
    expect(d.candidates[0].per_type_met).toBe(false);
    expect(d.outcome).toBe('page_only');
  });

  test('a net loss of exactly 2 is tolerated', () => {
    const prefStart = QUESTIONS.findIndex(q => q.type === 'single-session-preference');
    const chunkRight = new Set([prefStart, prefStart + 1]);
    const chunk: Outcome = i => (i < 200 || chunkRight.has(i) ? 1 : 0);
    const cand: Outcome = i => (chunkRight.has(i) ? 0 : i < 330 ? 1 : 0);
    const rows = { chunk: arm(chunk, 3400), page: arm(i => (i < 360 || chunkRight.has(i) ? 1 : 0), 15500), auto4k: arm(cand, 4500) };
    expect(decideConfirmatory(manifest, rows, IDS, ['auto4k']).outcome).toBe('success');
  });

  test('every stratum is tallied, including ones where the candidate is never different', () => {
    const d = decideConfirmatory(manifest, { ...base(), window1: arm(upTo(330), 6000) }, IDS, ['window1']);
    expect(d.candidates[0].per_type.map(t => t.type)).toEqual(STRATA);
    expect(d.candidates[0].per_type.reduce((s, t) => s + t.n, 0)).toBe(400);
  });
});

describe('confirmatory: judge disagreement', () => {
  test('the confirmation judge reversing a primary success makes the result inconclusive', () => {
    const rows = { ...base(), window1: arm(upTo(330), 6000, () => ({}), upTo(250)) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1']);
    expect(d.candidates[0].primary_success).toBe(true);
    expect(d.candidates[0].confirmation.agrees).toBe(false);
    expect(d.outcome).toBe('inconclusive');
    expect(d.winner).toBeNull();
  });

  test('the confirmation judge never rescues a primary failure', () => {
    const rows = { ...base(), window1: arm(upTo(300), 6000, () => ({}), upTo(355)) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1']);
    expect(d.candidates[0].closure_met).toBe(false);
    expect(d.outcome).toBe('page_only');
  });

  test('a confirmation judge that sees no page gap blocks a success too', () => {
    const rows = { chunk: arm(upTo(260), 3400), page: arm(upTo(360), 15500, () => ({}), upTo(260)), window1: arm(upTo(330), 6000) };
    expect(decideConfirmatory(manifest, rows, IDS, ['window1']).outcome).toBe('inconclusive');
  });
});

describe('pilot selection among many policies', () => {
  const PILOT = QUESTIONS.slice(0, 100).map(q => q.id);
  const pilotArm = (correct: number, tokens: number) => arm(upTo(correct), tokens).slice(0, 100);
  test('ranks eligible candidates by correct answers, then tokens, then family order, and advances two', () => {
    const rows: ArmRows = {
      chunk: pilotArm(65, 3400), page: pilotArm(88, 15000),
      window1: pilotArm(80, 7000), window2: pilotArm(82, 7400), section: pilotArm(82, 7400),
      auto4k: pilotArm(79, 4500), auto6k: pilotArm(84, 7400), auto7_5k: pilotArm(86, 9000),
    };
    const s = selectPilot(manifest, rows, PILOT);
    expect(s.status).toBe('ok');
    expect(s.candidates.find(c => c.id === 'auto7_5k')).toMatchObject({ eligible: false });
    expect(s.advanced).toEqual(['auto6k', 'window2']);
    expect(s.candidates.find(c => c.id === 'section')!.rank).toBe(3);
  });

  test('with one eligible candidate only that one advances; with none, nothing advances', () => {
    const one: ArmRows = { chunk: pilotArm(65, 3400), page: pilotArm(88, 15000), window1: pilotArm(80, 7000), window2: pilotArm(82, 9000), section: pilotArm(82, 9000), auto4k: pilotArm(79, 9000), auto6k: pilotArm(84, 9000), auto7_5k: pilotArm(86, 9000) };
    expect(selectPilot(manifest, one, PILOT).advanced).toEqual(['window1']);
    const none: ArmRows = { ...one, window1: pilotArm(80, 9000) };
    expect(selectPilot(manifest, none, PILOT).advanced).toEqual([]);
  });

  test('the page reference guard compares page with page_legacy on the pilot', () => {
    const rows: ArmRows = { chunk: pilotArm(65, 3400), page: pilotArm(88, 15000), window1: pilotArm(80, 7000), window2: pilotArm(82, 7400), section: pilotArm(82, 7400), auto4k: pilotArm(79, 4500), auto6k: pilotArm(84, 7600), auto7_5k: pilotArm(86, 7000), page_legacy: pilotArm(88, 15100) };
    expect(selectPilot(manifest, rows, PILOT).reference_guard).toMatchObject({ ok: true });
    rows.page_legacy = pilotArm(88, 14000);
    expect(selectPilot(manifest, rows, PILOT).reference_guard!.ok).toBe(false);
  });

  test('among several successes the winner has the most correct answers, then fewer tokens', () => {
    const rows = { ...base(), window1: arm(upTo(335), 6000), auto6k: arm(upTo(335), 5500) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1', 'auto6k']);
    expect(d.candidates.every(c => c.success)).toBe(true);
    expect(d.winner).toBe('auto6k');
    expect(gpt4oSecondArm(manifest, d)).toEqual({ arm: 'auto6k', label: 'winner' });
  });

  test('without a winner the gpt-4o arm uses the better advanced candidate, labeled as such', () => {
    const rows = { ...base(), window1: arm(upTo(300), 6000), auto6k: arm(upTo(310), 5500) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1', 'auto6k']);
    expect(d.winner).toBeNull();
    expect(gpt4oSecondArm(manifest, d)).toEqual({ arm: 'auto6k', label: 'best_advanced' });
  });

  test('a candidate outside the family cannot be decided', () => {
    const d = decideConfirmatory(manifest, { ...base(), k10: arm(upTo(340), 5000) }, IDS, ['k10']);
    expect(d.outcome).toBe('inconclusive');
    expect(d.problems.join(' ')).toContain('not family candidates: k10');
  });
});

describe('failed provider calls and missing rows', () => {
  test('reader errors count as incorrect for both judges', () => {
    const errors = new Set([0, 1, 2, 3, 4, 5]);
    const rows = { ...base(), window1: arm(upTo(330), 6000, i => (errors.has(i) ? { reader_error: 'provider_error', primary: null, confirmation: null } : {})) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1']);
    expect(d.candidates[0].correct).toBe(324);
  });

  test('more than 2% reader errors in an arm makes the decision inconclusive', () => {
    const rows = { ...base(), window1: arm(upTo(330), 6000, i => (i < 9 ? { reader_error: 'provider_error' } : {})) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1']);
    expect(d.outcome).toBe('inconclusive');
    expect(d.problems[0]).toContain('9 reader errors');
  });

  test('a missing question blocks the comparison instead of shrinking the denominator', () => {
    const rows = { ...base(), window1: arm(upTo(330), 6000).slice(1) };
    const d = decideConfirmatory(manifest, rows, IDS, ['window1']);
    expect(d.outcome).toBe('inconclusive');
    expect(d.problems[0]).toContain('1 question(s) missing');
  });

  test('a judge error counts as incorrect for that judge only', () => {
    const rows = { ...base(), window1: arm(upTo(330), 6000, i => (i === 0 ? { primary: null } : {})) };
    const c = decideConfirmatory(manifest, rows, IDS, ['window1']).candidates[0];
    expect(c.correct).toBe(329);
    expect(c.confirmation.delta_vs_chunk).toBe(70);
  });

  test('duplicate bodies in the page reference block the confirmatory decision', () => {
    const rows = { chunk: arm(upTo(260), 3400), page: arm(upTo(360), 15500, i => (i === 5 ? { duplicate_bodies: 1 } : {})), window1: arm(upTo(330), 6000) };
    expect(decideConfirmatory(manifest, rows, IDS, ['window1']).problems).toContain('page reference has duplicate delivered bodies');
  });
});

describe('E2 sealed no-regression rule', () => {
  const personas = Array.from({ length: 150 }, (_, i) => ({ id: `q${String(i).padStart(3, '0')}`, cluster: `p${Math.floor(i / 5)}` }));
  const sealed = (outcome: (i: number) => 0 | 1, extra: (i: number) => Partial<OutcomeRow> = () => ({}), confirmation?: (i: number) => 0 | 1): OutcomeRow[] =>
    personas.map((p, i) => ({ question_id: p.id, question_type: 'multi-session', cluster: p.cluster, primary: outcome(i), confirmation: (confirmation ?? outcome)(i), provider_input_tokens: 2000, ...extra(i) }));

  test('a tie passes', () => {
    const d = decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 120 ? 1 : 0)));
    expect(d.outcome).toBe('pass');
    expect(d.n_clusters).toBe(30);
  });

  test('two questions worse can still pass; three questions worse rejects', () => {
    expect(decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 118 ? 1 : 0))).outcome).toBe('pass');
    const d = decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 117 ? 1 : 0)));
    expect(d.outcome).toBe('reject');
    expect(d.primary.delta).toBe(-3);
  });

  test('more than three reader errors in either arm is inconclusive', () => {
    const d = decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 125 ? 1 : 0), i => (i < 4 ? { reader_error: 'x' } : {})));
    expect(d.outcome).toBe('inconclusive');
  });

  test('a primary pass with a failing confirmation judge is inconclusive', () => {
    const d = decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 121 ? 1 : 0), () => ({}), i => (i < 110 ? 1 : 0)));
    expect(d.outcome).toBe('inconclusive');
  });

  test('a missing sealed question is inconclusive', () => {
    const d = decideE2(manifest, sealed(i => (i < 120 ? 1 : 0)), sealed(i => (i < 120 ? 1 : 0)).slice(1));
    expect(d.outcome).toBe('inconclusive');
  });
});

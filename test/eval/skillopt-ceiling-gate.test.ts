import { describe, expect, test } from 'bun:test';
import { causeOf, gateVerdict, labelPair, solGateNeeded, stopVerdict, type GateInput, type GatePair, type PairLabel } from '../../eval/runner/skillopt-method/gate.ts';
import type { FrontierTarget } from '../../eval/runner/skillopt-method/headroom.ts';
import type { SkillName } from '../../eval/runner/skillopt-method/score.ts';

const SKILLS: SkillName[] = ['query', 'briefing', 'fact-check'];

/** A pair whose scores give the requested label. */
function pair(skill: SkillName, target: FrontierTarget, label: PairLabel, extra: Partial<GatePair> = {}): GatePair {
  const base: GatePair = { skill, target, form_fail: { no_skill: 0, seed: 0 }, proposals_passing_audit: 2, reachability: 0.95, limited_share: 0, refusal_limited: false, one_shot: 0.6, seed: 0.4 };
  const by: Record<PairLabel, Partial<GatePair>> = {
    headroom: {},
    saturated: { one_shot: 0.9 },
    difficulty: { seed: 0.1 },
    'harness-limited': { reachability: 0.6 },
    invalid: { form_fail: { no_skill: 0.2, seed: 0 } },
  };
  return { ...base, ...by[label], ...extra };
}

const pairs = (target: FrontierTarget, labels: PairLabel[], extra: Partial<GatePair> = {}) => labels.map((l, i) => pair(SKILLS[i]!, target, l, extra));
const gate = (opus: PairLabel[], sol: PairLabel[] | null, o: Partial<GateInput> = {}) =>
  gateVerdict({ pairs: [...pairs('opus', opus), ...(sol ? pairs('sol', sol) : [])], unsolvable: [], attempt: 1, ...o });

describe('labelPair', () => {
  test('thresholds sit where section 4 puts them', () => {
    expect(labelPair(pair('query', 'opus', 'headroom', { one_shot: 0.8, reachability: 0.95, seed: 0.7 }), [])).toBe('headroom');
    expect(labelPair(pair('query', 'opus', 'headroom', { seed: 0.2 }), [])).toBe('headroom');
    expect(labelPair(pair('query', 'opus', 'headroom', { seed: 0.71 }), [])).toBe('difficulty');
    expect(labelPair(pair('query', 'opus', 'headroom', { one_shot: 0.81 }), [])).toBe('saturated');
    expect(labelPair(pair('query', 'opus', 'headroom', { one_shot: 0.75, reachability: 0.89 }), [])).toBe('saturated');
    expect(labelPair(pair('query', 'opus', 'headroom', { one_shot: 0.7, reachability: 0.85 }), [])).toBe('headroom');
    expect(labelPair(pair('query', 'opus', 'headroom', { reachability: 0.84 }), [])).toBe('harness-limited');
    expect(labelPair(pair('query', 'opus', 'headroom', { limited_share: 0.34 }), [])).toBe('harness-limited');
    expect(labelPair(pair('query', 'opus', 'headroom', { limited_share: 1 / 3 }), [])).toBe('headroom');
  });

  test('invalid comes first: solvability, form failures above 10%, both proposals failing the audit', () => {
    expect(labelPair(pair('query', 'opus', 'saturated'), ['query'])).toBe('invalid');
    expect(labelPair(pair('query', 'opus', 'harness-limited', { form_fail: { no_skill: 0, seed: 0.11 } }), [])).toBe('invalid');
    expect(labelPair(pair('query', 'opus', 'headroom', { form_fail: { no_skill: 0.1, seed: 0.1 } }), [])).toBe('headroom');
    expect(labelPair(pair('query', 'opus', 'headroom', { proposals_passing_audit: 0 }), [])).toBe('invalid');
    expect(labelPair(pair('query', 'opus', 'headroom', { proposals_passing_audit: 1 }), [])).toBe('headroom');
  });
});

describe('causeOf: the truth table over scoped counts', () => {
  const c = (o: Partial<Record<'H' | 'S' | 'D' | 'X' | 'V' | 'U', number>>) => ({ H: 0, S: 0, D: 0, X: 0, V: 0, U: 0, ...o });
  test.each([
    [c({ H: 4, S: 2 }), 4, null],
    [c({ D: 6 }), 4, 'difficulty'],
    [c({ S: 3, D: 3 }), 4, 'saturated'],
    [c({ H: 1, S: 2, D: 3 }), 4, 'difficulty'],
    [c({ H: 1, S: 5 }), 4, 'saturated'],
    [c({ H: 3, S: 3 }), 4, 'underpowered'],
    [c({ H: 2, S: 4 }), 4, 'underpowered'],
    [c({ H: 2, X: 2, S: 2 }), 4, 'harness'],
    [c({ H: 1, X: 1, V: 2, S: 2 }), 4, 'invalid'],
    [c({ S: 2, D: 1 }), 2, 'saturated'],
    [c({ H: 1, D: 1, S: 1 }), 2, 'difficulty'],
    [c({ H: 2, S: 1 }), 2, null],
  ] as const)('%o with R = %d gives %s', (counts, required, cause) => {
    expect(causeOf(counts, required)).toBe(cause);
  });
});

describe('gateVerdict', () => {
  test('a pass needs four headroom pairs over all six', () => {
    const r = gate(['headroom', 'headroom', 'saturated'], ['headroom', 'headroom', 'difficulty']);
    expect(r).toMatchObject({ verdict: 'pass', cause: null, scope: ['opus', 'sol'], required: 4, next: 'b0' });
    expect(r.headroom_pairs).toEqual(['query/opus', 'briefing/opus', 'query/sol', 'briefing/sol']);
  });

  test('H = 3 with S = 3 is underpowered, not saturated, and may revise', () => {
    expect(gate(['headroom', 'headroom', 'headroom'], ['saturated', 'saturated', 'saturated'])).toMatchObject({ verdict: 'fail', cause: 'underpowered', next: 'revise' });
    expect(gate(['headroom', 'saturated', 'saturated'], ['headroom', 'saturated', 'saturated'])).toMatchObject({ cause: 'underpowered' });
    expect(gate(['headroom', 'saturated', 'saturated'], ['saturated', 'saturated', 'saturated'])).toMatchObject({ cause: 'saturated', next: 'revise' });
  });

  test('all difficulty, and difficulty mixed with saturation, never read as saturated', () => {
    expect(gate(['difficulty', 'difficulty', 'difficulty'], ['difficulty', 'difficulty', 'difficulty'])).toMatchObject({ cause: 'difficulty' });
    expect(gate(['headroom', 'saturated', 'difficulty'], ['saturated', 'difficulty', 'difficulty'])).toMatchObject({ cause: 'difficulty' });
  });

  describe('Sol wholly harness-limited: Opus read alone with R = 2, every cut scoped to Opus', () => {
    const X: PairLabel[] = ['harness-limited', 'harness-limited', 'harness-limited'];
    test.each([
      [['headroom', 'saturated', 'saturated'], 'saturated'],
      [['saturated', 'saturated', 'saturated'], 'saturated'],
      [['saturated', 'saturated', 'difficulty'], 'saturated'],
      [['headroom', 'difficulty', 'saturated'], 'difficulty'],
    ] as Array<[PairLabel[], string]>)('Opus %o gives %s', (opus, cause) => {
      expect(gate(opus, X)).toMatchObject({ verdict: 'fail', cause, scope: ['opus'], harness_target: 'sol', required: 2 });
    });

    test('a pass on two or three Opus pairs cannot be powered: underpowered, straight to the stop path', () => {
      expect(gate(['headroom', 'headroom', 'saturated'], X)).toMatchObject({ verdict: 'fail', cause: 'underpowered', scope: ['opus'], next: 'stop' });
      expect(gate(['headroom', 'headroom', 'headroom'], X)).toMatchObject({ cause: 'underpowered', next: 'stop' });
    });
  });

  test('both targets wholly harness-limited: harness with nothing measured', () => {
    const X: PairLabel[] = ['harness-limited', 'harness-limited', 'harness-limited'];
    expect(gate(X, X)).toMatchObject({ verdict: 'fail', cause: 'harness', scope: [], next: 'stop' });
  });

  test('harness from gbrain refusals skips the revision; other harness limits may revise', () => {
    const opus = pairs('opus', ['headroom', 'harness-limited', 'harness-limited']);
    const sol = pairs('sol', ['headroom', 'harness-limited', 'saturated'], { refusal_limited: true });
    const refused = opus.map(p => p.reachability < 0.85 ? { ...p, refusal_limited: true } : p);
    expect(gateVerdict({ pairs: [...refused, ...sol], unsolvable: [], attempt: 1 })).toMatchObject({ cause: 'harness', next: 'stop' });
    expect(gateVerdict({ pairs: [...opus, ...sol], unsolvable: [], attempt: 1 })).toMatchObject({ cause: 'harness', next: 'revise' });
  });

  test('a skill failing solvability makes the attempt invalid on both targets', () => {
    const r = gate(['headroom', 'headroom', 'headroom'], ['headroom', 'headroom', 'headroom'], { unsolvable: ['briefing'] });
    expect(r).toMatchObject({ verdict: 'invalid', cause: 'invalid', next: 'revise' });
    expect(r.labels['briefing/sol']).toBe('invalid');
  });

  test('a budget stop is incomplete whatever the scores', () => {
    expect(gate(['saturated', 'saturated', 'saturated'], ['saturated', 'saturated', 'saturated'], { budget_stop: true })).toMatchObject({ verdict: 'incomplete', cause: null, next: 'stop' });
  });

  test('the second attempt never revises', () => {
    expect(gate(['saturated', 'saturated', 'saturated'], ['saturated', 'saturated', 'difficulty'], { attempt: 2 })).toMatchObject({ cause: 'saturated', next: 'stop' });
  });

  test('Sol skipped after three saturated Opus pairs: saturated, read on Opus alone and scoped to it', () => {
    const r = gate(['saturated', 'saturated', 'saturated'], null);
    expect(r).toMatchObject({ verdict: 'fail', cause: 'saturated', scope: ['opus'], required: 2, harness_target: null, next: 'revise' });
    expect(r.labels['query/sol']).toBe('not-run');
    expect(gate(['saturated', 'saturated', 'difficulty'], null)).toMatchObject({ cause: 'saturated', scope: ['opus'] });
  });

  test('Sol pairs missing when Sol had to run make the attempt incomplete', () => {
    expect(gate(['headroom', 'headroom', 'headroom'], null)).toMatchObject({ verdict: 'incomplete', cause: null, next: 'stop' });
    const partial = gateVerdict({ pairs: [...pairs('opus', ['headroom', 'headroom', 'saturated']), pair('query', 'sol', 'headroom')], unsolvable: [], attempt: 1 });
    expect(partial.verdict).toBe('incomplete');
  });
});

describe('solGateNeeded', () => {
  const opusOnly = (labels: PairLabel[], o: Partial<GateInput> = {}): GateInput => ({ pairs: pairs('opus', labels), unsolvable: [], attempt: 1, ...o });
  test('skipped when no Opus pair has headroom and Opus alone reads saturated', () => {
    expect(solGateNeeded(opusOnly(['saturated', 'saturated', 'saturated']))).toBe(false);
    expect(solGateNeeded(opusOnly(['saturated', 'saturated', 'harness-limited']))).toBe(false);
  });
  test('runs when an Opus pair has headroom, or when Sol could change the cause', () => {
    expect(solGateNeeded(opusOnly(['headroom', 'saturated', 'saturated']))).toBe(true);
    expect(solGateNeeded(opusOnly(['headroom', 'headroom', 'headroom']))).toBe(true);
    expect(solGateNeeded(opusOnly(['saturated', 'difficulty', 'difficulty']))).toBe(true);
    expect(solGateNeeded(opusOnly(['harness-limited', 'harness-limited', 'harness-limited']))).toBe(true);
  });
  test('an unsolvable skill or a budget stop decides the attempt without Sol', () => {
    expect(solGateNeeded(opusOnly(['headroom', 'saturated', 'saturated'], { unsolvable: ['query'] }))).toBe(false);
    expect(solGateNeeded(opusOnly(['headroom', 'saturated', 'saturated'], { budget_stop: true }))).toBe(false);
  });
});

describe('stopVerdict', () => {
  const sat6: PairLabel[] = ['saturated', 'saturated', 'saturated'];
  test('two saturated attempts are a cut, scoped to the targets both measured', () => {
    expect(stopVerdict([gate(sat6, sat6), gate(sat6, sat6, { attempt: 2 })])).toMatchObject({ k_and_l: 'CUT-CANDIDATE', scope: ['opus', 'sol'] });
    const X: PairLabel[] = ['harness-limited', 'harness-limited', 'harness-limited'];
    const scoped = stopVerdict([gate(sat6, sat6), gate(sat6, X, { attempt: 2 })]);
    expect(scoped).toMatchObject({ k_and_l: 'CUT-CANDIDATE', scope: ['opus'] });
    expect(scoped.reason).toContain('sol not measured');
  });
  test('one saturated attempt is never a cut', () => {
    expect(stopVerdict([gate(sat6, sat6)]).k_and_l).toBe('FIX-METHOD');
  });
  test('two failed reachability gates are FIX-METHOD, never a cut', () => {
    const X: PairLabel[] = ['harness-limited', 'harness-limited', 'harness-limited'];
    expect(stopVerdict([gate(X, X), gate(X, X, { attempt: 2 })])).toMatchObject({ k_and_l: 'FIX-METHOD', causes: ['harness', 'harness'] });
  });
  test('saturated then underpowered is FIX-METHOD', () => {
    expect(stopVerdict([gate(sat6, sat6), gate(['headroom', 'headroom', 'headroom'], sat6, { attempt: 2 })])).toMatchObject({ k_and_l: 'FIX-METHOD', causes: ['saturated', 'underpowered'] });
  });
  test('a budget stop leaves K and L incomplete', () => {
    expect(stopVerdict([gate(sat6, sat6), gate(sat6, sat6, { attempt: 2, budget_stop: true })])).toMatchObject({ k_and_l: 'incomplete' });
  });
});

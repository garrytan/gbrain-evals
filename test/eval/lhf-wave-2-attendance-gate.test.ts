/**
 * LHF wave 2 attendance gate scorer: held-out fires count only when the parser
 * chose `attended`; competing-intent routes count on the chosen relation.
 */
import { describe, expect, test } from 'bun:test';
import { scoreGate } from '../../eval/runner/lhf-wave-2-attendance-gate.ts';

const row = (split: string, id: string, fired: boolean, recall = 0, template = 'attended') =>
  ({ seed: 1, query_id: id, split, template, kind: fired ? 'who_rel' : null, fired, on: { recall_at_5: recall }, error: null });

describe('lhf wave 2 attendance gate', () => {
  test('passes only when held-out fires on attendance at 80% with no competing route', () => {
    const base = [row('heldout-paraphrase', 'h1', false), row('heldout-paraphrase', 'h2', false), row('competing-intent', 'c1', false), row('one-hop-template', 't1', true, 1)];
    const branch = [row('heldout-paraphrase', 'h1', true, 1), row('heldout-paraphrase', 'h2', true, 1), row('competing-intent', 'c1', false), row('one-hop-template', 't1', true, 1)];
    const att = { linkTypes: ['attended'] };
    expect(scoreGate(base, branch, { base: {}, branch: { h1: att, h2: att } }).pass).toBe(true);
    expect(scoreGate(base, branch, { base: {}, branch: { h1: att, h2: { linkTypes: ['works_at'] } } }).rules.heldout_fire_rate_at_least_80pct).toBe(false);
    const routed = scoreGate(base, branch, { base: {}, branch: { h1: att, h2: att, c1: att } });
    expect(routed.rules.competing_zero_false_routes).toBe(false);
    expect(routed.pass).toBe(false);
  });
});

/**
 * N6 on Postgres over HTTP (W12): per-principal gold, the refusal test, cell
 * coverage and the preregistered verdict, all without a server.
 */
import { describe, expect, test } from 'bun:test';
import { generateN6World } from '../../eval/generators/n6-visibility-gen.ts';
import {
  MANDATORY_OPS, PRINCIPALS, forbiddenFor, isRefusal, rescore, scanFor, summarizeCells, verdictFor, type ProbeRow, type RefusalRow,
} from '../../eval/runner/n6-postgres-http.ts';
import type { CallOutcome } from '../../eval/runner/n6-visibility-fuzz.ts';

const ledger = generateN6World();
const ok = (data: unknown): CallOutcome => ({ exposed: true, ok: true, raw: JSON.stringify(data), data });
const foreign = ledger.classes.find(c => c.class === 'foreign_source')!;
const privatePage = ledger.classes.find(c => c.class === 'private_page')!;

describe('gold per principal', () => {
  test('the frozen list holds the 31 ops N6 covered at c5fb0201', () => {
    expect(MANDATORY_OPS).toHaveLength(31);
    expect(new Set(MANDATORY_OPS).size).toBe(31);
  });

  test('scoped may see neither beta nor any private class; owner may see beta but no private class', () => {
    const scoped = forbiddenFor(ledger, 'scoped');
    const owner = forbiddenFor(ledger, 'owner');
    expect(scoped.markers).toEqual(expect.arrayContaining(foreign.protected_markers));
    expect(owner.markers.some(m => foreign.protected_markers.includes(m))).toBe(false);
    expect(owner.markers).toEqual(expect.arrayContaining(privatePage.protected_markers));
    expect([scoped.betaForbidden, owner.betaForbidden]).toEqual([true, false]);
  });

  test('a beta row is an existence leak for scoped and allowed for owner; a private marker leaks for both', () => {
    const beta = ok({ results: [{ slug: 'projects/x', source_id: 'beta' }] });
    expect(scanFor(beta, forbiddenFor(ledger, 'scoped'), []).existence).toMatch(/beta/);
    expect(scanFor(beta, forbiddenFor(ledger, 'owner'), []).existence).toBeNull();
    const priv = ok({ text: `memo ${privatePage.protected_markers[0]}` });
    expect(scanFor(priv, forbiddenFor(ledger, 'owner'), []).content).toContain(privatePage.protected_markers[0]);
  });
});

describe('refusals', () => {
  test('401 and 403 are refusals; a 200 tool result is not; an auth JSON-RPC error is', () => {
    expect(isRefusal(401, '')).toBe(true);
    expect(isRefusal(403, 'forbidden')).toBe(true);
    expect(isRefusal(200, JSON.stringify({ result: { content: [] } }))).toBe(false);
    expect(isRefusal(200, JSON.stringify({ error: { message: 'Unauthorized: invalid token' } }))).toBe(true);
    expect(isRefusal(500, 'oops')).toBe(false);
  });
});

const row = (p: ProbeRow['principal'], op: string, phase: ProbeRow['phase'], status: ProbeRow['status'] = 'clean'): ProbeRow => ({ phase, principal: p, op, target: 'private_page', variant: 'base', status, control: status === 'clean' });
const refused = (p: RefusalRow['principal'], op: string, ok = true, canary: string | null = null): RefusalRow => ({ principal: p, op, http_status: ok ? 401 : 200, refused: ok, canary, detail: '' });

function honest(ops: readonly string[]): { rows: ProbeRow[]; refusals: RefusalRow[] } {
  const rows: ProbeRow[] = [];
  const refusals: RefusalRow[] = [];
  for (const op of ops) {
    rows.push(row('owner', op, 'warm-owner'), row('owner', op, 'interleaved'), row('scoped', op, 'interleaved'), row('scoped', op, 'scoped-again'));
    for (const p of ['none', 'invalid-token', 'expired-token'] as const) refusals.push(refused(p, op));
  }
  return { rows, refusals };
}
const mandatory = (op: string) => (MANDATORY_OPS as readonly string[]).includes(op);
const calls = { total: 1000, harness_errors: 0 };

describe('cells and the verdict', () => {
  test('every mandatory cell covered with no leak passes', () => {
    const { rows, refusals } = honest(MANDATORY_OPS);
    const cells = summarizeCells(MANDATORY_OPS, rows, refusals, { poolConditionMet: true, mandatory });
    expect(cells).toHaveLength(31 * PRINCIPALS.length);
    expect(verdictFor(cells, calls)).toMatchObject({ pass: true, mandatory_cells: 155, mandatory_covered: 155 });
  });

  test('one leak, one oracle or one accepted unauthenticated request fails', () => {
    const base = honest(MANDATORY_OPS);
    const leak = summarizeCells(MANDATORY_OPS, [...base.rows, row('scoped', 'get_page', 'scoped-again', 'leak')], base.refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(leak, calls).pass).toBe(false);
    const oracle = summarizeCells(MANDATORY_OPS, [...base.rows, row('owner', 'entity', 'interleaved', 'oracle')], base.refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(oracle, calls).oracles).toBe(1);
    const accepted = summarizeCells(MANDATORY_OPS, base.rows, [...base.refusals, refused('none', 'search', false)], { poolConditionMet: true, mandatory });
    expect(verdictFor(accepted, calls)).toMatchObject({ pass: false, accepted: 1 });
    const canary = summarizeCells(MANDATORY_OPS, base.rows, [...base.refusals, refused('invalid-token', 'search', true, privatePage.protected_markers[0])], { poolConditionMet: true, mandatory });
    expect(verdictFor(canary, calls).pass).toBe(false);
  });

  test('a missing mandatory cell fails: no signal, a scoped cell without both later phases, or the pool condition unmet', () => {
    const base = honest(MANDATORY_OPS);
    const noSignal = summarizeCells(MANDATORY_OPS, base.rows.filter(r => !(r.principal === 'owner' && r.op === 'think')), base.refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(noSignal, calls).missing_mandatory).toEqual(['owner:think']);
    const onePhase = summarizeCells(MANDATORY_OPS, base.rows.filter(r => !(r.principal === 'scoped' && r.op === 'recall' && r.phase === 'scoped-again')), base.refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(onePhase, calls).missing_mandatory).toEqual(['scoped:recall']);
    const noPool = summarizeCells(MANDATORY_OPS, base.rows, base.refusals, { poolConditionMet: false, mandatory });
    expect(verdictFor(noPool, calls).mandatory_covered).toBe(31 * 3);
  });

  test('optional cells never fail the gate unless they leak', () => {
    const ops = [...MANDATORY_OPS, 'schema_stats'];
    const { rows, refusals } = honest(MANDATORY_OPS);
    const quiet = summarizeCells(ops, rows, refusals, { poolConditionMet: true, mandatory });
    expect(quiet.filter(c => c.op === 'schema_stats').every(c => c.status === 'Not covered')).toBe(true);
    expect(verdictFor(quiet, calls).pass).toBe(true);
    const leaky = summarizeCells(ops, [...rows, row('scoped', 'schema_stats', 'interleaved', 'leak')], refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(leaky, calls).pass).toBe(false);
  });

  test('harness errors at 2% or more of calls fail', () => {
    const { rows, refusals } = honest(MANDATORY_OPS);
    const cells = summarizeCells(MANDATORY_OPS, rows, refusals, { poolConditionMet: true, mandatory });
    expect(verdictFor(cells, { total: 100, harness_errors: 2 }).pass).toBe(false);
    expect(verdictFor(cells, { total: 100, harness_errors: 1 }).pass).toBe(true);
  });

  test('rescore reproduces the verdict from a stored receipt and fails a dead expiring-token control', () => {
    const { rows, refusals } = honest(MANDATORY_OPS);
    const cells = summarizeCells(MANDATORY_OPS, rows, refusals, { poolConditionMet: true, mandatory });
    const receipt = { data: { cells, metrics: { calls: 1000, harness_errors: 0 }, handshake: [], controls: { expiring_token_valid_before_expiry: true } } };
    expect(rescore(receipt).pass).toBe(true);
    expect(rescore({ data: { ...receipt.data, controls: { expiring_token_valid_before_expiry: false } } }).pass).toBe(false);
    expect(rescore({ data: { ...receipt.data, handshake: [refused('none', '(initialize)', false)] } }).pass).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedSequence } from '../../eval/runner/stats/fixed-sequence.ts';
import { confirmPackages, loadArm, safetyChecks, selectUnits, type ArmData } from '../../eval/runner/q2/c-gates.ts';
import { closureCorrect, goldTransitions, newWrong, transitionMetrics } from '../../eval/runner/q2/transitions.ts';
import { generateTemporalEdgesWorld } from '../../eval/generators/temporal-edges-gen.ts';

type Row = Record<string, unknown>;
/** A synthetic arm: `lift` raises a metric's success probability deterministically on a subset of 240 people. */
function arm(label: string, o: { lift?: Record<string, number>; extraWrong?: string[] } = {}): ArmData {
  const te: Row[] = [];
  const lift = o.lift ?? {};
  const v = (metric: string, i: number, base: number) => Number(((i * 37) % 100) / 100 < base + (lift[metric] ?? 0));
  for (let i = 0; i < 240; i++) {
    const c = `s3:p${i}`;
    for (const m of ['now_precision', 'now_recall', 'asof_exact', 'during_f1', 'correction_ok']) te.push({ probe_id: `s3:${m}:${i}`, cluster: c, [m]: v(m, i, 0.8) });
    te.push({ probe_id: `s3:live:${i}`, cluster: c, live_recall: v('live_recall', i, 0.6) });
    for (const f of ['advises', 'invest', 'alumni']) te.push({ probe_id: `s3:trap-${f}:p${i}`, cluster: c, trap_ok: v(`trap_${f}`, i, 0.5) });
    te.push({ probe_id: `s3:invariant:${i}`, kind: 'invariant', cluster: c, invariant: 1 });
    te.push({ probe_id: `s3:ti-wrong:${i}`, kind: 'transitions_identity', cluster: c, ti_wrong: 0, ti_wrong_ids: i === 0 ? (o.extraWrong ?? []) : [] });
    te.push({ probe_id: `s3:ti-missing:${i}`, kind: 'transitions_identity', cluster: c, ti_missing: 0, ti_missing_ids: [] });
    te.push({ probe_id: `s3:ti-start:${i}`, kind: 'transitions_identity', cluster: c, ti_start_recall: v('ti_start_recall', i, 0.7) });
    te.push({ probe_id: `s3:ti-end:${i}`, kind: 'transitions_identity', cluster: c, ti_end_recall: v('ti_end_recall', i, 0.7) });
    te.push({ probe_id: `s3:e5-false-starts:${i}`, kind: 'e5', cluster: c, e5_false_starts: 1 - v('e5_ok', i, 0.3), e5_false_start_ids: [] });
  }
  const w: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, kind: 'edge', cluster: `pg${i % 60}`, gold_type: ['works_at', 'advises', 'invested_in'][i % 3], correctly_typed: Number(i % 5 !== 0) }));
  const world: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: `g${i}`, kind: 'edge', cluster: `wp${i % 80}`, anyTypeMatch: Number(i % 4 !== 0) }));
  return { label, te, w, wSummary: { spurious_specific_points: 3.0 }, world, sources: {} };
}

describe('fixed-sequence testing', () => {
  test('stops at the first failure; later steps are not tested; the prefix ships', () => {
    const evaluated: string[] = [];
    const step = (id: string, pass: boolean) => ({ id, evaluate: () => { evaluated.push(id); return { pass, detail: id }; } });
    const r = fixedSequence([step('P1', true), step('P2', false), step('P3', true)]);
    expect(r.results.map(x => x.status)).toEqual(['pass', 'fail', 'not_tested']);
    expect(r.longest_passing_prefix).toEqual(['P1']);
    expect(evaluated).toEqual(['P1', 'P2']);
    expect(fixedSequence([step('P1', false), step('P2', true)]).longest_passing_prefix).toEqual([]);
  });
});

describe('C-gate selection (Holm across units, safety as intersection-union)', () => {
  const base = arm('baseline');
  test('a superior unit is selected; a null unit is not; a unit with a new wrong transition fails safety', () => {
    const r = selectUnits(base, {
      U2: arm('U2', { lift: { live_recall: 0.3 } }),
      U5: arm('U5'),
      U6: arm('U6', { lift: { ti_start_recall: 0.25 }, extraWrong: ['people/a|companies/b|works_at|start|2020-01-01'] }),
      U1: arm('U1', { lift: { trap_advises: 0.2 } }),
    });
    const by = Object.fromEntries(r.units.map(u => [u.unit, u]));
    expect(by.U2.selected).toBe(true);
    expect(by.U5.selected).toBe(false);
    expect(by.U6.holm_pass).toBe(true);
    expect(by.U6.safety.find(s => s.id === 'new_wrong_transitions')!.pass).toBe(false);
    expect(by.U6.selected).toBe(false);
    expect(by.U1.selected).toBe(true);
    expect(r.order).toEqual(['U2', 'U1']);
    expect(by.U2.standardized_effect!).toBeGreaterThan(by.U1.standardized_effect!);
  });
  test('safety catches a regression on any temporal gate, a lower trap count, invariance and spurious types', () => {
    const worse = arm('worse', { lift: { asof_exact: -0.2, trap_alumni: -0.05 } });
    worse.te.find(r => r.kind === 'invariant')!.invariant = 0;
    worse.wSummary = { spurious_specific_points: 3.6 };
    const failed = safetyChecks(worse, base).filter(s => !s.pass).map(s => s.id);
    expect(failed).toEqual(expect.arrayContaining(['ni:asof_exact', 'trap_count:alumni', 'write_order_invariance', 'w_spurious_specific_types']));
    expect(safetyChecks(base, base).every(s => s.pass)).toBe(true);
  });
  test('the "lower is better" primary (false starts) is oriented', () => {
    const r = selectUnits(base, { U4: arm('U4', { lift: { e5_ok: 0.4 } }) });
    expect(r.units[0].primary.oriented_delta).toBeGreaterThan(0);
    expect(r.units[0].selected).toBe(true);
  });
});

describe('C-gate confirmation (fixed sequence against Pj-1, safety against baseline)', () => {
  const base = arm('baseline');
  test('P2 fails when its added unit is not superior to P1; P3 is never tested', () => {
    const p1 = arm('P1', { lift: { live_recall: 0.3 } });
    const p2 = arm('P2', { lift: { live_recall: 0.3 } });
    const p3 = arm('P3', { lift: { live_recall: 0.3, ti_end_recall: 0.3 } });
    const r = confirmPackages(['U2', 'U1', 'U5'], base, [p1, p2, p3]);
    expect(r.results.map(x => x.status)).toEqual(['pass', 'fail', 'not_tested']);
    expect(r.longest_passing_prefix).toEqual(['P1']);
  });
  test('an earlier unit that loses ground against Pj-1 fails the step', () => {
    const p1 = arm('P1', { lift: { live_recall: 0.3 } });
    const p2 = arm('P2', { lift: { live_recall: 0.1, ti_end_recall: 0.3 } });
    const r = confirmPackages(['U2', 'U5'], base, [p1, p2]);
    expect(r.results[1].status).toBe('fail');
    expect(r.results[1].detail!.earlier[0]).toMatchObject({ unit: 'U2', pass: false });
  });
  test('the package count must match the selected order', () => {
    expect(() => confirmPackages(['U2', 'U1'], base, [arm('P1')])).toThrow('needs 2 package');
  });
});

describe('C-gate inputs', () => {
  test('a temporal-edges receipt that is not a --c-gate run is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q2-cg-'));
    const rec = (c: boolean) => JSON.stringify({ run_status: 'completed', category: 'x', resolved_config: { c_gate: c }, data: { rows: [], summary: {} } });
    writeFileSync(join(dir, 'te.json'), rec(false)); writeFileSync(join(dir, 'w.json'), rec(false)); writeFileSync(join(dir, 'world.json'), rec(false));
    expect(() => loadArm('U1', `te=${join(dir, 'te.json')},w=${join(dir, 'w.json')},world=${join(dir, 'world.json')}`)).toThrow('--c-gate');
    expect(() => loadArm('U1', `te=${join(dir, 'te.json')}`)).toThrow('w is missing');
  });
});

describe('transition identity and closures from explicit ledger intervals', () => {
  const stints = [
    { company: 'companies/a', from: '2010-01-01', until: '2012-01-01', role: 'x' },
    { company: 'companies/b', from: '2012-06-01', until: '2014-01-01', role: 'x' },
    { company: 'companies/a', from: '2014-01-01', until: null, role: 'x' },
    { company: 'companies/c', from: '2015-01-01', until: null, role: 'x', concurrent: true as const },
  ];
  test('a gap closes at the stint end, never at the next start; a concurrent job is never closed; a rejoin matches the stint that ended', () => {
    expect(closureCorrect(stints, 'companies/a', '2012-01-01')).toBe(true);
    expect(closureCorrect(stints, 'companies/a', '2012-06-01')).toBe(false);
    expect(closureCorrect(stints, 'companies/c', '2016-01-01')).toBe(false);
    expect(closureCorrect(stints, 'companies/b', '2014-01-01')).toBe(true);
    expect(closureCorrect(stints, 'companies/a', '2014-01-01')).toBe(false);
  });
  test('wrong, missing and recall by identity; dates match at the observed precision', () => {
    const p = { slug: 'people/x', name: 'X', style: 'timeline' as const, stints, advises: null, invests_after_exit: null, alumni_meeting: null, rejoin_eu: false };
    const gold = goldTransitions(p);
    expect(gold).toHaveLength(6);
    const m = transitionMetrics(gold, [
      { subject: 'people/x', target: 'companies/a', type: 'works_at', kind: 'start', date: '2010-01-01' },
      { subject: 'people/x', target: 'companies/b', type: 'works_at', kind: 'start', date: '2012-06-01', precision: 'month' },
      { subject: 'people/x', target: 'companies/c', type: 'works_at', kind: 'end', date: '2016-01-01' },
      { subject: 'people/x', target: 'companies/z', type: 'works_at', kind: 'start', date: '2016-01-01' },
      { subject: 'people/x', target: 'companies/z', type: 'invested_in', kind: 'start', date: '2016-01-01' },
    ]);
    expect(m.wrong).toEqual(['people/x|companies/c|works_at|end|2016-01-01', 'people/x|companies/z|works_at|start|2016-01-01']);
    expect(m.false_works_at_starts).toEqual(['people/x|companies/z|works_at|start|2016-01-01']);
    expect(m.observed_starts).toBe(2);
    expect(m.gold_starts).toBe(4);
    expect(m.missing).toHaveLength(4);
    expect(newWrong(['a', 'b', 'b'], ['a'])).toEqual(['b']);
  });
  test('the Q2 ledger adds concurrent jobs without changing the plain world', () => {
    const plain = generateTemporalEdgesWorld({ seed: 3 });
    const q2 = generateTemporalEdgesWorld({ seed: 3, q2Ledger: true });
    expect(q2.people.map(p => p.stints.filter(s => !s.concurrent))).toEqual(plain.people.map(p => p.stints));
    expect(q2.people.some(p => p.stints.filter(s => s.until === null).length === 2)).toBe(true);
    expect(q2.fingerprint).not.toBe(plain.fingerprint);
  });
});

describe('line-grammar-typing custodian helpers', () => {
  test('custody pages are access-logged; rows are hash-only but still pair across arms; spurious specific types count non-mentions only', async () => {
    const { loadCustodyPages, redactRows, spuriousSpecific } = await import('../../eval/runner/line-grammar-typing.ts');
    const { existsSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'q2-w-'));
    writeFileSync(join(dir, 'p1.json'), JSON.stringify({ slug: 'people/alice-example', type: 'person', title: 'Alice', compiled_truth: ['a', 'b'], timeline: [], _facts: { type: 'person' } }));
    const { pages, files_sha256 } = loadCustodyPages(dir, { decisionId: 'q2', purpose: 'W1' });
    expect(pages[0].compiled_truth).toBe('a\n\nb');
    expect(files_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'access-log.jsonl'), 'utf8')).toContain('"W1"');
    const rows = redactRows([{ id: 'people/alice-example->companies/acme-example', kind: 'edge', cluster: 'people/alice-example', from: 'people/alice-example', to: 'companies/acme-example', correctly_typed: 1 }]);
    expect(JSON.stringify(rows)).not.toContain('alice');
    expect(redactRows([{ id: 'people/alice-example->companies/acme-example', kind: 'edge', cluster: 'people/alice-example' }])[0].id).toBe(rows[0].id);
    expect(spuriousSpecific([{ goldType: 'works_at', inferredTypes: ['works_at', 'mentions', 'advises'] }, { goldType: null, inferredTypes: ['invested_in'] }])).toEqual({ specific_typed_edges: 3, spurious_specific: 2, spurious_specific_points: 200 / 3 });
    expect(existsSync(join(dir, 'p1.json'))).toBe(true);
  });
});

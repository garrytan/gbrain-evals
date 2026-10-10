/**
 * Cat 38 state resolution (eval/runner/cat38-state-resolution.ts): generator
 * determinism and fictional names, the tier oracle on hand-built sequences,
 * the served-current rule and answer scoring on hand-built gold (with
 * negatives that must fail), deliberately broken adapters the category must
 * fail, the scorer mutation suite, the dry stub's label reading, the paid
 * guard, and one light end-to-end run against the pinned gbrain (which has
 * no trust features: it must complete and report them as gaps).
 *
 * Everything but the last two blocks is pure: no gbrain import, no overlay.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAT38_DEFAULT_SEED, CONTESTED_KINDS, factText, generateCat38World, mentionsValue, oracle, parseSlotValue, tierRank,
  type Cat38Gold, type Cat38Probe, type GeneratedCat38, type Sequence,
} from '../../eval/generators/cat38-state-resolution-gen.ts';
import {
  aggregateModelRows, cat38Verdict, isChallenger, finalAnswer, findingsFrom, labelReadingStub, mcnemarByModel, paidEstimateUsd, readRows, runArm, scoreAnswer, scoreArm,
  scoreServed, servedCurrent, stratifiedProbes, type ProbeObs, type ReadRow, type Violation,
} from '../../eval/runner/cat38-state-resolution.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import type { TrustCapabilities } from '../../eval/runner/memory-trust/sut.ts';

const world = generateCat38World();
const ALL_CAPS: TrustCapabilities = {
  trust_tiers: true, write_gate: true, write_gate_holds: true, activation_control: true, content_origin: true,
  guarded_supersession: true, confirm_memory: true, purge_fact: true, page_purge_tombstones: true, deletion_inventory: true,
};

describe('generator', () => {
  test('same seed, same ledger hash; different seed differs; size is an option', () => {
    const again = generateCat38World({ seed: CAT38_DEFAULT_SEED });
    const other = generateCat38World({ seed: CAT38_DEFAULT_SEED + 1 });
    expect(world.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(again.fingerprint).toBe(world.fingerprint);
    expect(again.probes.map(p => p.id)).toEqual(world.probes.map(p => p.id));
    expect(other.fingerprint).not.toBe(world.fingerprint);
    expect(world.ledger.sequences).toHaveLength(200);
    expect(generateCat38World({ sequences: 40 }).ledger.sequences).toHaveLength(40);
  });

  test('every kind, negative controls and twins; gold for every probe; values distinct within a sequence', () => {
    const kinds = new Set(world.ledger.sequences.map(s => s.kind));
    for (const k of [...CONTESTED_KINDS, 'single_write', 'twin_control']) expect(kinds.has(k as never)).toBe(true);
    for (const p of world.probes) expect(world.gold.has(p.id)).toBe(true);
    expect(world.negative.size).toBe(30);
    const bySeq = new Map(world.ledger.sequences.map(s => [s.id, s]));
    for (const s of world.ledger.sequences) {
      const values = s.steps.flatMap(st => (st.op === 'write' ? [st.value] : []));
      expect(new Set(values).size).toBe(values.length);
      if (s.kind === 'twin_control') {
        const base = bySeq.get(s.twin_of!)!;
        expect(s.entity.slug).toBe(`${base.entity.slug}-twin`);
        expect(s.slot).toBe(base.slot);
        expect(values.some(v => base.steps.some(b => b.op === 'write' && b.value === v))).toBe(false);
      }
    }
  });

  test('fictional placeholder names only', () => {
    for (const s of world.ledger.sequences) {
      expect(s.entity.slug).toMatch(/^(people|companies)\/[a-z]+-example-\d+(-twin)?$/);
      expect(s.entity.title).toMatch(/^[A-Z][a-z]+ Example \d+( Twin)?$/);
      for (const st of s.steps) if (st.op === 'write' && s.slot === 'billing contact') expect(st.value).toMatch(/^[a-z]+-example$/);
    }
  });

  test('fact text round-trips through the slot parser; value matching respects token edges', () => {
    const s = world.ledger.sequences[0]!;
    const st = s.steps[0] as { value: string };
    expect(parseSlotValue(factText(s.entity, s.slot, st.value))).toEqual({ slot: s.slot, value: st.value });
    expect(mentionsValue('plan-gold', 'plan-gold')).toBe(true);
    expect(mentionsValue('plan-golden', 'plan-gold')).toBe(false);
    expect(mentionsValue('the contact is ben-example.', 'ben-example')).toBe(true);
    expect(mentionsValue('aben-example', 'ben-example')).toBe(false);
  });
});

const entity = { slug: 'people/x-example-1', title: 'X Example 1', type: 'person' as const };
const seq = (steps: Sequence['steps']): Sequence => ({ id: 'h', kind: 'owner_agent_replaces', entity, slot: 'office city', steps, negative: false });

describe('tier oracle on hand-built sequences', () => {
  test('a less trusted replaces is contested and leaves the target current; an equal tier supersedes', () => {
    const g = oracle(seq([{ op: 'write', channel: 'owner_curated', value: 'oslo' }, { op: 'write', channel: 'agent', value: 'lima', replaces: 0 }]));
    expect(g.current).toBe('oslo');
    expect(g.rows[0]).toMatchObject({ active: true, guarded: true, tier: 'operator_curated' });
    expect(g.rows[1]).toMatchObject({ active: true, contested: true, contests: 0, tier: 'agent_written' });
    const eq = oracle(seq([{ op: 'write', channel: 'agent', value: 'oslo' }, { op: 'write', channel: 'agent', value: 'lima', replaces: 0 }]));
    expect(eq.current).toBe('lima');
    expect(eq.rows[0]).toMatchObject({ active: false, superseded_by: 1 });
    expect(eq.prior).toBe('oslo');
  });

  test('the owner CLI write is decided at agent_written, then confirmed; accept supersedes and confirms', () => {
    const upd = oracle(seq([{ op: 'write', channel: 'agent', value: 'oslo' }, { op: 'write', channel: 'owner_confirmed', value: 'lima', replaces: 0 }]));
    expect(upd.current).toBe('lima');
    expect(upd.rows[1]!.tier).toBe('user_confirmed');
    const accepted = seq([{ op: 'write', channel: 'owner_confirmed', value: 'oslo' }, { op: 'write', channel: 'agent', value: 'lima', replaces: 0 }, { op: 'accept', of: 1 }]);
    const acc = oracle(accepted);
    expect(acc.current).toBe('lima');
    expect(acc.rows[0]).toMatchObject({ active: false, superseded_by: 1 });
    expect(acc.rows[1]).toMatchObject({ contested: false, tier: 'user_confirmed' });
    expect(oracle(accepted, 2).current).toBe('oslo');
    expect(() => oracle(seq([{ op: 'write', channel: 'agent', value: 'oslo' }, { op: 'accept', of: 0 }]))).toThrow();
  });

  test('a contradiction without replaces: less trusted is contested, equal tier may supersede, newest equal wins', () => {
    const ext = oracle(seq([{ op: 'write', channel: 'agent', value: 'oslo' }, { op: 'write', channel: 'external', value: 'lima' }]));
    expect(ext.current).toBe('oslo');
    expect(ext.rows[1]).toMatchObject({ contested: true, contests: 0 });
    const eq = oracle(seq([{ op: 'write', channel: 'agent', value: 'oslo' }, { op: 'write', channel: 'agent', value: 'lima' }]));
    expect(eq.current).toBe('lima');
    expect(eq.rows[0]).toMatchObject({ active: true, may_expire: true, guarded: false });
  });

  test('tier order', () => {
    expect(tierRank('user_confirmed')).toBeGreaterThan(tierRank('operator_curated'));
    expect(tierRank('agent_written')).toBeGreaterThan(tierRank('external_untrusted'));
    expect(tierRank(null)).toBe(tierRank('unknown'));
  });
});

const row = (o: Partial<ReadRow> & { value: string }): ReadRow => ({
  fact_id: '1', text: factText(entity, 'office city', o.value), slot: 'office city', tier: 'agent_written', active: true, contested: false, valid_from: '2026-01-01T00:00:00Z', ...o,
});

describe('served-current rule and scoring on hand-built gold', () => {
  const gold = { current: 'oslo', candidates: ['oslo', 'lima'] };

  test('the most trusted active row wins; inactive and contested-marked rows are not served; newest among equals', () => {
    expect(servedCurrent([row({ value: 'lima', fact_id: '2', valid_from: '2026-09-01T00:00:00Z' }), row({ value: 'oslo', tier: 'operator_curated' })], 'office city')).toEqual(['oslo']);
    expect(servedCurrent([row({ value: 'oslo', active: false, tier: 'user_confirmed' }), row({ value: 'lima' })], 'office city')).toEqual(['lima']);
    expect(servedCurrent([row({ value: 'lima', tier: 'user_confirmed', contested: true }), row({ value: 'oslo' })], 'office city')).toEqual(['oslo']);
    expect(servedCurrent([row({ value: 'oslo', fact_id: '1' }), row({ value: 'lima', fact_id: '2', valid_from: '2026-02-01T00:00:00Z' })], 'office city')).toEqual(['lima']);
    expect(servedCurrent([row({ value: 'oslo' })], 'plan tier')).toEqual([]);
  });

  test('scoreServed: the gold alone passes; a stale value, nothing, everything or another entity\'s value fails', () => {
    expect(scoreServed(gold, ['oslo'])).toEqual({ correct: true, stale: false, wrong_source: false });
    expect(scoreServed(gold, ['lima'])).toEqual({ correct: false, stale: true, wrong_source: false });
    expect(scoreServed(gold, [])).toEqual({ correct: false, stale: false, wrong_source: false });
    expect(scoreServed(gold, ['oslo', 'lima'])).toMatchObject({ correct: false, stale: true });
    expect(scoreServed(gold, ['perth'])).toMatchObject({ correct: false, wrong_source: true });
  });

  test('readRows: expired, superseded and past valid_until rows are inactive; tier and contested are read as returned', () => {
    const rs = readRows([
      { fact_id: '1', fact: 'X Example 1\'s office city is oslo.', trust_tier: 'operator_curated', expired_at: null, superseded_by: null, valid_until: null },
      { fact_id: '2', fact: 'X Example 1\'s office city is lima.', expired_at: '2026-01-01', superseded_by: null },
      { fact_id: '3', fact: 'X Example 1\'s office city is perth.', superseded_by: 1 },
      { fact_id: '4', fact: 'X Example 1\'s office city is porto.', valid_until: '2020-01-01', contested: true },
    ]);
    expect(rs.map(r => [r.value, r.active, r.tier, r.contested])).toEqual([['oslo', true, 'operator_curated', false], ['lima', false, null, false], ['perth', false, null, false], ['porto', false, null, true]]);
  });

  test('scoreAnswer: gold alone is accurate; any other candidate is stale; hedging between both is not accurate', () => {
    expect(scoreAnswer('oslo', gold)).toEqual({ correct: true, stale: false });
    expect(scoreAnswer('lima', gold)).toEqual({ correct: false, stale: true });
    expect(scoreAnswer('oslo or lima', gold)).toEqual({ correct: false, stale: true });
    expect(scoreAnswer('UNKNOWN', gold)).toEqual({ correct: false, stale: false });
    expect(finalAnswer({ final: { answer: 'oslo', notes: 'previously lima', sources: [] }, text: '' })).toBe('oslo');
  });
});

// ─── Adapters built from gold: the honest one and deliberately broken ones ───

/** What an ideal gbrain would return: every oracle-active row with its oracle tier, contested rows marked on read and held as proposals. */
function honestObservations(w: GeneratedCat38): ProbeObs[] {
  const bySeq = new Map(w.ledger.sequences.map((s, i) => [s.id, { s, i }]));
  return w.probes.map(p => {
    const { s, i } = bySeq.get(p.sequence)!;
    const g = w.gold.get(p.id)!;
    const id = (step: number) => String(i * 10 + step + 1);
    return {
      probe_id: p.id, sequence: s.id,
      rows: g.rows.filter(r => r.active).map(r => ({ fact_id: id(r.step), text: factText(s.entity, s.slot, r.value), slot: s.slot, value: r.value, tier: r.tier, active: true, contested: r.contested, valid_from: new Date(Date.UTC(2026, 0, 1 + r.step)).toISOString() })),
      pending_related: g.rows.filter(r => r.contested).map(r => id(r.step)),
      writes: s.steps.map((st, step) => ({ step, op: st.op === 'write' ? st.channel : 'accept' as const, ok: true, fact_id: st.op === 'write' ? id(step) : null, proposal_ref: g.rows.some(r => r.step === step && r.contested) ? `tp${id(step)}` : null })),
    };
  });
}

describe('the category fails broken adapters', () => {
  const honest = honestObservations(world);

  test('the honest adapter passes every gate', () => {
    const s = scoreArm(world, honest, []);
    expect(s.metrics).toMatchObject({ current_fact_accuracy: 1, stale_as_current_rate: 0, lower_tier_supersede_violations: 0, label_accuracy: 1, contested_visible_rate: 1, probes: 200, sequences: 200 });
    expect(cat38Verdict(s.metrics)).toBe('pass');
    expect(findingsFrom(s, [], ALL_CAPS, 'repro')).toEqual([]);
  });

  test('labels stripped (a pre-#5575 build): newest row wins, stale values served, label accuracy 0', () => {
    const stripped = honest.map(o => ({ ...o, rows: o.rows.map(r => ({ ...r, tier: null, contested: false })) }));
    const s = scoreArm(world, stripped, []);
    expect(s.metrics.stale_as_current_rate).toBeGreaterThan(0.3);
    expect(s.metrics.label_accuracy).toBe(0);
    expect(cat38Verdict(s.metrics)).toBe('fail');
  });

  test('silent lower-tier supersession: guarded rows expire, the contested value is served and counted as a violation', () => {
    const violations: Violation[] = [];
    const broken = honest.map(o => {
      const g = world.gold.get(o.probe_id)!;
      const guarded = new Set(g.rows.filter(r => r.guarded && r.active).map(r => r.value));
      for (const r of g.rows.filter(x => x.guarded && x.active)) violations.push({ sequence: o.sequence, step: r.step, round: 2, tier: r.tier, fact_id: 'x', superseded_by: null, cause_tier: 'agent_written' });
      return { ...o, rows: o.rows.map(r => (guarded.has(r.value!) ? { ...r, active: false } : { ...r, contested: false })), pending_related: [] };
    });
    const s = scoreArm(world, broken, violations);
    expect(s.metrics.lower_tier_supersede_violations).toBeGreaterThan(50);
    expect(s.metrics.stale_as_current_rate).toBeGreaterThan(0.3);
    expect(cat38Verdict(s.metrics)).toBe('fail');
    expect(findingsFrom(s, violations, ALL_CAPS, 'repro').map(f => f.id)).toContain('lower-tier-supersede');
  });

  test('a guarded write whose response omits contested.proposal_ref is named per verb (DX-1)', () => {
    const silent = honest.map(o => ({ ...o, writes: o.writes.map(w => ({ ...w, proposal_ref: w.op === 'agent_page' ? null : w.proposal_ref })) }));
    const s = scoreArm(world, silent, []);
    expect(s.exploratory.contested_reported_to_writer).not.toBe(`${s.exploratory.contested_with_pending_proposal}/${s.exploratory.contested_with_pending_proposal}`);
    expect(findingsFrom(s, [], ALL_CAPS, 'repro').map(f => f.id)).toEqual(['contested-not-reported-put_page']);
  });

  test('mislabeling agent rows as the owner\'s notes fails label accuracy even when every value is right', () => {
    const lying = honest.map(o => ({ ...o, rows: o.rows.map(r => (r.tier === 'agent_written' ? { ...r, tier: 'operator_curated' } : r)) }));
    const s = scoreArm(world, lying, []);
    expect(s.metrics.label_accuracy).toBeLessThan(1);
    expect(cat38Verdict(s.metrics)).toBe('fail');
  });

  test('a recall that throws everywhere is a scored miss, never a pass; leaked twin rows count as wrong-source', () => {
    const failing = honest.map(o => ({ ...o, rows: [], error: 'boom' }));
    expect(cat38Verdict(scoreArm(world, failing, []).metrics)).toBe('fail');
    const twin = world.ledger.sequences.find(s => s.kind === 'twin_control')!;
    const base = honest.find(o => o.sequence === twin.twin_of)!;
    const leakedRow = honest.find(o => o.sequence === twin.id)!.rows.map(r => ({ ...r, tier: 'user_confirmed', valid_from: '2026-12-01T00:00:00Z' }));
    const leaked = honest.map(o => (o === base ? { ...o, rows: [...o.rows, ...leakedRow] } : o));
    const s = scoreArm(world, leaked, []);
    expect(s.rows.find(r => r.sequence === base.sequence)).toMatchObject({ correct: false, wrong_source: true });
  });

  test('contested rows readable without a mark or proposal are not visible, and the finding names it', () => {
    const unmarked = honest.map(o => ({ ...o, rows: o.rows.map(r => ({ ...r, contested: false })), pending_related: [] }));
    const s = scoreArm(world, unmarked, []);
    expect(s.metrics.contested_visible_rate).toBe(0);
    expect(cat38Verdict(s.metrics)).toBe('pass');
    expect(findingsFrom(s, [], ALL_CAPS, 'repro').map(f => f.id)).toEqual(['keyless-conflict-slot']);
  });
});

describe('scorer mutation suite', () => {
  const probes = world.probes;
  const gold = (p: Cat38Probe): Cat38Gold => world.gold.get(p.id)!;
  const wrongSource = (p: Cat38Probe): string | undefined => {
    for (const q of probes) if (q.slot === p.slot && q.id !== p.id && !gold(p).candidates.includes(gold(q).current)) return gold(q).current;
    return undefined;
  };

  test('served-current scoring: honest passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    const results = assertScorerRejectsFakeSystems<Cat38Probe, string[]>({
      category: 'cat38-state-resolution',
      probes,
      space: {
        truth: p => [gold(p).current],
        empty: () => [],
        everything: p => [...gold(p).candidates],
        refusal: () => [],
        stale: p => (gold(p).prior && gold(p).prior !== gold(p).current ? [gold(p).prior!] : undefined),
        wrongSource: p => { const v = wrongSource(p); return v ? [v] : undefined; },
      },
      score: answers => {
        const scored = answers.map((a, i) => scoreServed(gold(probes[i]!), a));
        const metrics = { current_fact_accuracy: scored.filter(s => s.correct).length / scored.length, stale_as_current_rate: scored.filter(s => s.stale).length / scored.length, lower_tier_supersede_violations: 0, label_accuracy: 1, contested_visible_rate: 1, probes: scored.length, sequences: scored.length };
        return { pass: cat38Verdict(metrics) === 'pass', detail: `${metrics.current_fact_accuracy.toFixed(3)} accurate, ${metrics.stale_as_current_rate.toFixed(3)} stale` };
      },
    });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });

  test('model-arm answer scoring: honest passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    assertScorerRejectsFakeSystems<Cat38Probe, string>({
      category: 'cat38-model-arm',
      probes,
      space: {
        truth: p => gold(p).current,
        empty: () => '',
        everything: p => gold(p).candidates.join(', '),
        refusal: () => 'UNKNOWN',
        stale: p => (gold(p).prior && gold(p).prior !== gold(p).current ? gold(p).prior! : undefined),
        wrongSource: p => wrongSource(p),
      },
      score: answers => {
        const scored = answers.map((a, i) => scoreAnswer(a, gold(probes[i]!)));
        const acc = scored.filter(s => s.correct).length / scored.length;
        const stale = scored.filter(s => s.stale).length / scored.length;
        return { pass: acc === 1 && stale === 0, detail: `${acc.toFixed(3)} accurate, ${stale.toFixed(3)} stale` };
      },
    });
  });
});

describe('model arm helpers', () => {
  const probe = { entity: 'people/x-example-1', slot: 'office city' as const };
  const history = (labels: boolean) => [{
    name: 'recall', args: {}, result: JSON.stringify({ facts: [
      { fact_id: '2', fact: 'X Example 1\'s office city is lima.', valid_from: '2026-10-01T00:00:00Z', ...(labels ? { trust_tier: 'agent_written' } : {}) },
      { fact_id: '1', fact: 'X Example 1\'s office city is oslo.', valid_from: '2026-01-01T00:00:00Z', ...(labels ? { trust_tier: 'operator_curated' } : {}) },
      { fact_id: '3', fact: 'X Example 1\'s office city is perth.', valid_from: '2026-10-02T00:00:00Z', ...(labels ? { trust_tier: 'external_untrusted' } : {}) },
    ] }),
  }];

  test('the stub reads labels when they are visible and takes the newest row when they are not', () => {
    const stub = labelReadingStub(probe);
    expect(stub([])).toEqual({ name: 'recall', args: { entity: probe.entity } });
    expect(stub(history(true)).args).toMatchObject({ answer: 'oslo' });
    expect(stub(history(false)).args).toMatchObject({ answer: 'perth' });
  });

  test('cells aggregate per model and arm; errors leave the denominator; paid estimate counts both arms', () => {
    const r = (arm: 'labels-on' | 'labels-off', correct: boolean, error?: string) => ({ model: 'stub', arm, probe_id: 'p', kind: 'single_write' as const, repeat: 0, answer: '', correct, stale: !correct && !error, usd: 0, tools: 1, injected_chars: 0, ...(error ? { error } : {}) });
    const cells = aggregateModelRows([r('labels-on', true), r('labels-on', false), r('labels-off', false), r('labels-off', false, 'x')]);
    expect(cells).toEqual([
      { model: 'stub', arm: 'labels-on', n: 2, current_fact_accuracy: 0.5, stale_as_current_rate: 0.5, errors: 0, usd: 0 },
      { model: 'stub', arm: 'labels-off', n: 1, current_fact_accuracy: 0, stale_as_current_rate: 1, errors: 1, usd: 0 },
    ]);
    expect(paidEstimateUsd(['stub'], 200, 1)).toBe(0);
    expect(paidEstimateUsd(['claude-sonnet-5-5'], 200, 1)).toBeCloseTo(2 * paidEstimateUsd(['claude-sonnet-5-5'], 100, 1));
  });

  test('stratified subset covers every kind; McNemar pairs labels-on with labels-off by probe and repeat', () => {
    const sub = stratifiedProbes(world.probes, 100);
    expect(sub).toHaveLength(100);
    expect(new Set(sub.map(p => p.kind)).size).toBe(new Set(world.probes.map(p => p.kind)).size);
    expect(stratifiedProbes(world.probes, 100).map(p => p.id)).toEqual(sub.map(p => p.id));
    expect(stratifiedProbes(world.probes, undefined)).toHaveLength(200);
    const r = (arm: 'labels-on' | 'labels-off', probe_id: string, correct: boolean) => ({ model: 'm', arm, probe_id, kind: 'single_write' as const, repeat: 0, answer: '', correct, stale: !correct, usd: 0, tools: 1, injected_chars: 0 });
    const rows = [...Array.from({ length: 8 }, (_, i) => [r('labels-on', `p${i}`, true), r('labels-off', `p${i}`, false)]).flat(), r('labels-on', 'q', true), r('labels-off', 'q', true)];
    const [t] = mcnemarByModel(rows);
    expect(t).toMatchObject({ model: 'm', pairs: 9, on_only: 8, off_only: 0 });
    expect(t!.p_two_sided).toBeCloseTo(2 / 256);
  });

  test('the paid arm refuses without --paid --budget-run-id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat38-ledger-'));
    try {
      const child = Bun.spawn([process.execPath, 'eval/runner/cat38-state-resolution.ts', '--model-arm', 'paid', '--models', 'claude-sonnet-5-5'], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BRAINBENCH_BUDGET_LEDGER: join(dir, 'ledger.json') },
      });
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(err).toMatch(/PaidArmRefusal: .*--paid --budget-run-id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('end to end against the pinned gbrain', () => {
  test('small world: completes, reports every missing trust feature as a gap, scores every probe', async () => {
    const gut = resolveGbrainUnderTest(null);
    const small = generateCat38World({ seed: 7, sequences: 24 });
    const r = await withHermeticEnv('cat38-test', () => runArm(gut, small, 'default'));
    expect(r.harness_error).toBe(null);
    for (const p of r.presence) expect([p.name, p.ok]).toEqual([p.name, true]);
    expect(r.capabilities.trust_tiers).toBe(false);
    expect(r.observations).toHaveLength(small.probes.length);
    const s = scoreArm(small, r.observations, r.violations);
    expect(s.metrics.probes).toBe(24);
    expect(Number.isFinite(s.metrics.current_fact_accuracy)).toBe(true);
    expect(s.metrics.label_accuracy).toBe(0);
    expect(s.exploratory.negative_control_accuracy).toBe(1);
    expect(findingsFrom(s, r.violations, r.capabilities, 'repro')).toEqual([]);
  }, 180_000);
});

test('only the challenger of a contested pair leaves the served set; the challenged higher-tier row stays current', () => {
  expect(isChallenger({ proposal_ref: 'tp3', role: 'challenger' })).toBe(true);
  expect(isChallenger({ proposal_ref: 'tp3', role: 'challenged' })).toBe(false);
  expect(isChallenger(true)).toBe(true);
  expect(isChallenger(undefined)).toBe(false);
});

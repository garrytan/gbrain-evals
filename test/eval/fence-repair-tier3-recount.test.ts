/**
 * Tier 3 fence-repair receipts (2026-10-06, gbrain #6188 T4): recount the
 * published numbers of both rounds from the raw per-fixture rows. Keyless,
 * $0, no network. Round 2 counts gate-pass and false-accept over the fences
 * that reached the model (amendment 1) and qualifies a model only when it
 * meets the rule on the held-out set and on the round 1 fixtures.
 *
 * Each row in docs/benchmarks/2026-10-06-fence-repair-tier3/results/ is one
 * fixture run with its outcome and its match against the ground truth, as
 * gbrain's harness recorded them. This test recounts gate-pass, false-accept,
 * adversarial holds and spend per model and checks them against summary.json,
 * verdict.json and the preregistered decision rule (gate-pass >= 80%,
 * false-accept <= 1%), so a hand-edited summary or report number fails here.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(import.meta.dir, '../../docs/benchmarks/2026-10-06-fence-repair-tier3');

interface Row {
  model: string; run: number; id: string; set: 'repairable' | 'adversarial' | 'gate_limited'; adversarial: 'ambiguous' | 'unrecoverable' | null;
  outcome: 'repaired' | 'held' | 'not_sent'; match_cells: boolean | null; spent_usd: number; tier1: string;
}

const rows: Row[] = readdirSync(join(DIR, 'results')).filter(f => /-run\d\.jsonl$/.test(f)).sort()
  .flatMap(f => readFileSync(join(DIR, 'results', f), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
const summary = JSON.parse(readFileSync(join(DIR, 'summary.json'), 'utf8'));
const verdict = JSON.parse(readFileSync(join(DIR, 'verdict.json'), 'utf8'));
const MODELS = ['anthropic:claude-opus-4-7', 'anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1'];

function recount(model: string) {
  const mine = rows.filter(r => r.model === model);
  const rep = mine.filter(r => r.set === 'repairable');
  const adv = mine.filter(r => r.set === 'adversarial');
  const repaired = rep.filter(r => r.outcome === 'repaired').length;
  const falseAccepts = rep.filter(r => r.outcome === 'repaired' && r.match_cells === false).length;
  return {
    runs: new Set(mine.map(r => r.run)).size, n: rep.length, repaired, falseAccepts,
    advHeld: adv.filter(r => r.outcome !== 'repaired').length, advN: adv.length,
    ambHeld: adv.filter(r => r.adversarial === 'ambiguous' && r.outcome !== 'repaired').length,
    usd: mine.reduce((s, r) => s + r.spent_usd, 0),
    meets: repaired / rep.length >= 0.8 && falseAccepts / rep.length <= 0.01,
  };
}

describe('fence-repair Tier 3 receipts', () => {
  test('1,170 fixture runs: 5 models x 3 runs x 78 fixtures, every one reached Tier 3', () => {
    expect(rows.length).toBe(1170);
    for (const model of MODELS) expect(recount(model)).toMatchObject({ runs: 3, n: 198, advN: 27 });
    expect(rows.every(r => r.tier1 === 'llm')).toBe(true);
  });

  test('per-model counts match summary.json and verdict.json', () => {
    for (const model of MODELS) {
      const c = recount(model);
      const s = summary.models.find((m: { model: string }) => m.model === model);
      const v = verdict.models[model];
      expect([s.repairable.repaired, s.repairable.false_accepts, s.adversarial.held, s.adversarial.ambiguous_held, s.meets_rule]).toEqual([c.repaired, c.falseAccepts, c.advHeld, c.ambHeld, c.meets]);
      expect([v.repaired, v.false_accepts, v.adversarial_held, v.ambiguous_held, v.meets_rule]).toEqual([c.repaired, c.falseAccepts, c.advHeld, c.ambHeld, c.meets]);
      expect(s.cost.usd_total).toBeCloseTo(c.usd, 9);
    }
  });

  test('the published headline numbers', () => {
    const got = Object.fromEntries(MODELS.map(m => { const c = recount(m); return [m, [c.repaired, c.falseAccepts, c.ambHeld]]; }));
    expect(got).toEqual({
      'anthropic:claude-opus-4-7': [195, 8, 14],
      'anthropic:claude-opus-5-5': [195, 3, 18],
      'anthropic:claude-sonnet-5-5': [195, 10, 15],
      'openai:gpt-6.1-sol': [198, 1, 7],
      'anthropic:claude-fable-5-1': [191, 0, 18],
    });
    expect(MODELS.filter(m => recount(m).meets)).toEqual(['openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1']);
    expect(verdict.verdict.recommended_default_by_rule).toBe('openai:gpt-6.1-sol');
    expect(rows.reduce((s, r) => s + r.spent_usd, 0)).toBeCloseTo(9.7456, 3);
  });
});

describe('fence-repair Tier 3 round 2 receipts', () => {
  const R2 = join(DIR, 'round-2');
  const r2 = (set: string): Array<Row & { tier1: string }> => readdirSync(join(R2, 'results')).filter(f => f.startsWith(`${set}-`) && /-run\d\.jsonl$/.test(f)).sort()
    .flatMap(f => readFileSync(join(R2, 'results', f), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  const verdict2 = JSON.parse(readFileSync(join(R2, 'verdict.json'), 'utf8'));
  const tier3 = (rows: Array<Row & { tier1: string }>, model: string) => {
    const t3 = rows.filter(r => r.model === model && r.set === 'repairable' && r.tier1 === 'llm');
    const repaired = t3.filter(r => r.outcome === 'repaired').length;
    const falseAccepts = t3.filter(r => r.outcome === 'repaired' && r.match_cells === false).length;
    return { n: t3.length, repaired, falseAccepts, meets: repaired / t3.length >= 0.8 && falseAccepts / t3.length <= 0.01 };
  };

  test('1,950 fixture runs: 78 round 1 and 52 held-out fixtures, 5 models x 3 runs', () => {
    expect(r2('fixtures').length).toBe(1170);
    expect(r2('heldout').length).toBe(780);
  });

  test('Tier 3 counts per set, the qualifying models and the default order', () => {
    const counts = Object.fromEntries(['heldout', 'fixtures'].map(set => [set, Object.fromEntries(MODELS.map(m => { const c = tier3(r2(set), m); return [m, [c.repaired, c.n, c.falseAccepts]]; }))]));
    expect(counts).toEqual({
      heldout: {
        'anthropic:claude-opus-4-7': [96, 99, 0], 'anthropic:claude-opus-5-5': [95, 99, 0], 'anthropic:claude-sonnet-5-5': [96, 99, 3],
        'openai:gpt-6.1-sol': [95, 99, 0], 'anthropic:claude-fable-5-1': [93, 99, 0],
      },
      fixtures: {
        'anthropic:claude-opus-4-7': [162, 165, 3], 'anthropic:claude-opus-5-5': [157, 165, 0], 'anthropic:claude-sonnet-5-5': [144, 165, 3],
        'openai:gpt-6.1-sol': [156, 165, 0], 'anthropic:claude-fable-5-1': [154, 165, 0],
      },
    });
    const qualifies = MODELS.filter(m => tier3(r2('heldout'), m).meets && tier3(r2('fixtures'), m).meets);
    expect(qualifies).toEqual(['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1']);
    expect(Object.entries(verdict2.qualifies).filter(([, q]) => q).map(([m]) => m).sort()).toEqual([...qualifies].sort());
    expect(verdict2.default_pick.measured_models_order).toEqual(['openai:gpt-6.1-sol', 'anthropic:claude-opus-5-5', 'anthropic:claude-fable-5-1']);
    for (const set of ['heldout', 'fixtures']) {
      const summary2 = JSON.parse(readFileSync(join(R2, `summary-${set}.json`), 'utf8'));
      for (const m of MODELS) {
        const c = tier3(r2(set), m);
        const s = summary2.models.find((x: { model: string }) => x.model === m);
        expect([s.repairable.repaired, s.repairable.n, s.repairable.false_accepts, s.meets_rule]).toEqual([c.repaired, c.n, c.falseAccepts, c.meets]);
        expect([verdict2.sets[set][m].repaired, verdict2.sets[set][m].false_accepts]).toEqual([c.repaired, c.falseAccepts]);
      }
    }
    expect([...r2('fixtures'), ...r2('heldout')].reduce((s, r) => s + r.spent_usd, 0)).toBeCloseTo(13.6711, 3);
  });
});


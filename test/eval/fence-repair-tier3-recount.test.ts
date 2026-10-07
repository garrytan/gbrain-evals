/**
 * Tier 3 fence-repair receipts (2026-10-06, gbrain #6188 T4): recount the
 * published numbers from the raw per-fixture rows. Keyless, $0, no network.
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

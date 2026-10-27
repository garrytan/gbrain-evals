#!/usr/bin/env bun
/**
 * Change / contradiction / compatible lane scorer (N2 contradiction surfacing).
 *
 * System output: { "pairs": [{ "id": "cp-bwf-renewal", "relation": "change" | "contradiction" | "compatible" }], "retractions"?: [{ "id": "rt-qfl-seats", "value": 185 }] }
 * Pair ids and both sides (slug, line, value) are in labels/changes; a system
 * reads the two sources and classifies the pair. Retraction rows ask for the
 * value that stands after "ignore my earlier note".
 *
 * Metrics: pair relation accuracy, contradiction recall and precision
 * (treating "contradiction" as the positive class), retraction final-value
 * accuracy. Prints the confusion counts.
 */
import { emit, group, loadGold, metric, parseCli, sameValue, type Report, type Split } from './common.ts';

export function scoreChanges(split: Split, system: { pairs?: { id: string; relation: string }[]; retractions?: { id: string; value: unknown }[] }, gold = loadGold('changes', split)): Report {
  const rel = new Map((system.pairs ?? []).map(p => [p.id, p.relation]));
  const ret = new Map((system.retractions ?? []).map(p => [p.id, p.value]));
  const pairs = gold.filter(g => g.kind === 'pair').map(g => ({ g, got: rel.get(g.id) ?? 'missing' }));
  const rts = gold.filter(g => g.kind === 'retraction').map(g => ({ g, ok: ret.has(g.id) && sameValue(g.final_value, ret.get(g.id)) }));
  const contra = pairs.filter(p => p.g.relation === 'contradiction'), saidContra = pairs.filter(p => p.got === 'contradiction');
  const confusion: Record<string, number> = {};
  for (const p of pairs) confusion[`${p.g.relation}->${p.got}`] = (confusion[`${p.g.relation}->${p.got}`] ?? 0) + 1;
  return {
    lane: 'changes', split,
    metrics: [
      metric('pair relation correct', pairs.filter(p => p.got === p.g.relation).length, pairs.length),
      metric('contradiction recall', contra.filter(p => p.got === 'contradiction').length, contra.length),
      metric('contradiction precision', saidContra.filter(p => p.g.relation === 'contradiction').length, saidContra.length),
      metric('retraction final value correct', rts.filter(r => r.ok).length, rts.length),
    ],
    breakdown: { 'gold relation': group(pairs, p => p.g.relation, p => p.got === p.g.relation) },
    extra: { confusion },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreChanges(c.split, c.system), c.json); }

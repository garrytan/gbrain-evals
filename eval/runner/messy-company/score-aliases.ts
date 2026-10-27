#!/usr/bin/env bun
/**
 * Alias lane scorer.
 *
 * System output: { "aliases": [{ "surface": "TCC", "entity": "tamsin" }] }
 * Each entry asserts that the surface names the entity. Gold rows say valid
 * true or false (false rows are look-alikes, family names and corpus typos).
 *
 * Metrics: recall of valid aliases, precision over asserted pairs the gold
 * knows, and the false-alias rate (valid:false pairs asserted). Breakdown by
 * alias kind and by whether the surface collides with another entity.
 */
import { emit, group, loadGold, metric, parseCli, type Report, type Split } from './common.ts';

export function scoreAliases(split: Split, system: { aliases?: { surface: string; entity: string }[] }, gold = loadGold('aliases', split)): Report {
  const asserted = new Set((system.aliases ?? []).map(a => `${a.surface}\u0000${a.entity}`));
  const rows = gold.map(g => ({ g, said: asserted.has(`${g.surface}\u0000${g.entity}`) }));
  const valid = rows.filter(r => r.g.valid), invalid = rows.filter(r => !r.g.valid);
  const known = rows.filter(r => r.said);
  return {
    lane: 'aliases', split,
    metrics: [
      metric('valid alias recall', valid.filter(r => r.said).length, valid.length),
      metric('precision over known pairs', known.filter(r => r.g.valid).length, known.length),
      metric('false aliases asserted', invalid.filter(r => r.said).length, invalid.length, 'lower is better'),
    ],
    breakdown: {
      'kind (correct decision)': group(rows, r => `${r.g.kind}${r.g.valid ? '' : ' [false]'}`, r => r.said === r.g.valid),
      'collides (correct decision)': group(rows, r => (r.g.collides_with.length ? 'colliding surface' : 'unique surface'), r => r.said === r.g.valid),
    },
    extra: { asserted_pairs_unknown_to_gold: (system.aliases ?? []).filter(a => !gold.some(g => g.surface === a.surface && g.entity === a.entity)).length },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreAliases(c.split, c.system), c.json); }

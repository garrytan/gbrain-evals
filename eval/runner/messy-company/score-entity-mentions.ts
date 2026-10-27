#!/usr/bin/env bun
/**
 * Entity-mention lane scorer (look-alike disambiguation).
 *
 * System output: { "mentions": [{ "slug": "chats/...", "line": 12, "surface": "TCC", "occurrence"?: 2, "entity": "orrin" | null }] }
 * Matches gold by slug, line, surface and occurrence (the 1-based ordinal of
 * that surface on that line; default 1). A gold mention with no answer counts
 * as wrong. `entity: null` means the occurrence names no single company: not a
 * company at all, or the code discussed as a string ("stop writing TP").
 *
 * Metrics: accuracy over all gold mentions, and over the hard subsets:
 * colliding surfaces (codes and family names two entities share) and
 * look-alike names.
 */
import { emit, group, loadGold, metric, parseCli, type Report, type Split } from './common.ts';

export function scoreEntityMentions(split: Split, system: { mentions?: { slug: string; line: number; surface: string; occurrence?: number; entity: string | null }[] }, gold = loadGold('entity-mentions', split)): Report {
  const idx = new Map((system.mentions ?? []).map(m => [`${m.slug}|${m.line}|${m.surface}|${m.occurrence ?? 1}`, m.entity ?? null]));
  const rows = gold.map(g => { const k = `${g.slug}|${g.line}|${g.surface}|${g.occurrence}`; return { g, answered: idx.has(k), ok: idx.has(k) && idx.get(k) === g.entity }; });
  const amb = rows.filter(r => r.g.ambiguous_surface), look = rows.filter(r => r.g.lookalike_surface);
  return {
    lane: 'entity-mentions', split,
    metrics: [
      metric('accuracy (all mentions)', rows.filter(r => r.ok).length, rows.length),
      metric('accuracy on colliding surfaces', amb.filter(r => r.ok).length, amb.length),
      metric('accuracy on look-alike names', look.filter(r => r.ok).length, look.length),
      metric('answered', rows.filter(r => r.answered).length, rows.length),
    ],
    breakdown: { surface: group(rows.filter(r => r.g.ambiguous_surface || r.g.lookalike_surface), r => r.g.surface, r => r.ok) },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreEntityMentions(c.split, c.system), c.json); }

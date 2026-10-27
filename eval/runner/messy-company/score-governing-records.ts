#!/usr/bin/env bun
/**
 * Governing-record lane scorer (F1 governing record, F2 deciding passage).
 *
 * System output: { "answers": [{ "id": "quarrendon:seats:2026-10-14", "value": 185, "record_slug"?: "contracts/...", "passage"?: { "slug": "contracts/...", "line": 41 } }] }
 * Gold ids are `<account>:<attribute>:<as-of date>`.
 *
 * Metrics: value accuracy, governing-record accuracy (when record_slug is
 * given, else counted wrong), deciding-passage hit (right slug and within 3
 * lines of the gold line). Breakdown by trap.
 */
import { emit, group, loadGold, metric, parseCli, sameValue, type Report, type Split } from './common.ts';

export function scoreGoverning(split: Split, system: { answers?: { id: string; value: unknown; record_slug?: string; passage?: { slug: string; line: number } }[] }, gold = loadGold('governing-records', split)): Report {
  const by = new Map((system.answers ?? []).map(a => [a.id, a]));
  const rows = gold.map(g => {
    const a = by.get(g.id);
    const passageOk = !!a?.passage && a.passage.slug === g.deciding_passage.slug && g.deciding_passage.line !== null && Math.abs(a.passage.line - g.deciding_passage.line) <= 3;
    return { g, value: !!a && sameValue(g.value, a.value), record: a?.record_slug === g.governing_slug, passage: passageOk };
  });
  const withLine = rows.filter(r => r.g.deciding_passage.line !== null);
  return {
    lane: 'governing-records', split,
    metrics: [
      metric('value correct', rows.filter(r => r.value).length, rows.length),
      metric('governing record correct', rows.filter(r => r.record).length, rows.length),
      metric('deciding passage hit (slug, +-3 lines)', withLine.filter(r => r.passage).length, withLine.length),
    ],
    breakdown: {
      'trap (value correct)': group(rows.flatMap(r => (r.g.traps.length ? r.g.traps : ['none']).map((t: string) => ({ t, ok: r.value }))), x => x.t, x => x.ok),
      'attribute (value correct)': group(rows, r => r.g.attribute, r => r.value),
    },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreGoverning(c.split, c.system), c.json); }

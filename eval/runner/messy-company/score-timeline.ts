#!/usr/bin/env bun
/**
 * Timeline lane scorer (auto_chronicle-style event extraction).
 *
 * System output: { "events": [{ "date": "2025-11-04", "accounts": ["quarrendon"], "type"?: "escalation", "slug"?: "tickets/..." }] }
 * A gold event is found when an output event has the same date and shares at
 * least one account. Output events on a corrected announcement's never-happened
 * date for that account (labels/timeline rows with negative: true) count as
 * false events.
 *
 * Metrics: event recall, precision of output events against gold events, and
 * false events on announced-but-corrected handoffs. Breakdown by event type.
 */
import { emit, group, loadGold, metric, parseCli, type Report, type Split } from './common.ts';

export function scoreTimeline(split: Split, system: { events?: { date: string; accounts: string[]; type?: string }[] }, gold = loadGold('timeline', split)): Report {
  const evs = system.events ?? [];
  const pos = gold.filter(g => !g.negative), neg = gold.filter(g => g.negative);
  const match = (e: { date: string; accounts: string[] }, g: any) => e.date === g.date && (g.accounts.length === 0 || e.accounts.some(a => g.accounts.includes(a)));
  const rows = pos.map(g => ({ g, ok: evs.some(e => match(e, g)) }));
  const matched = evs.filter(e => pos.some(g => match(e, g)));
  const falseEvents = neg.filter(g => evs.some(e => e.date === g.negative_date && e.accounts.some(a => g.accounts.includes(a))));
  return {
    lane: 'timeline', split,
    metrics: [
      metric('event recall (date + account)', rows.filter(r => r.ok).length, rows.length),
      metric('event precision', matched.length, evs.length),
      metric('events on corrected announcement dates', falseEvents.length, neg.length, 'lower is better'),
    ],
    breakdown: { type: group(rows, r => r.g.type, r => r.ok) },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreTimeline(c.split, c.system), c.json); }

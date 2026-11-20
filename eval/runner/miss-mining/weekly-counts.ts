#!/usr/bin/env bun
/**
 * Weekly miss counts: the only miss-mining output that leaves the box. It counts
 * one week's entries of the private miss log by cause x ask kind x detection
 * mode, and nothing else (no ids, dates inside the week, slugs or ask text),
 * then passes the export through custody.ts before writing it.
 *
 *   bun eval/runner/miss-mining/weekly-counts.ts --log <miss-log.jsonl> --week <YYYY-MM-DD> --out <weekly.json>
 *
 * --week is any date in the week; weeks run Monday to Sunday in UTC.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WEEKLY_SCHEMA, checkMissExport } from './custody.ts';
import { MissMiningRefusal, missNeedles, parseMissLog, type MissEntry } from './schema.ts';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday and Sunday of the UTC week holding date. */
export function weekOf(date: string): { start: string; end: string } {
  const ms = Date.parse(date + 'T00:00:00Z');
  if (Number.isNaN(ms)) throw new MissMiningRefusal('MM_LOG_INVALID', 'week is not a date');
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
  return { start: iso(monday), end: iso(monday + 6 * DAY) };
}

/** counts[cause][ask_kind][detection] for the week's entries; empty cells are left out. */
export function weeklyCounts(entries: MissEntry[], week: string) {
  const { start, end } = weekOf(week);
  const inWeek = entries.filter(e => e.date >= start && e.date <= end);
  const counts: Record<string, Record<string, Record<string, number>>> = {};
  for (const e of inWeek) {
    const byKind = (counts[e.cause] ??= {});
    const byMode = (byKind[e.ask_kind] ??= {});
    byMode[e.detection] = (byMode[e.detection] ?? 0) + 1;
  }
  return { schema: WEEKLY_SCHEMA, week_start: start, week_end: end, n_entries: inWeek.length, counts };
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[]): number {
  const log = flag(argv, '--log'), week = flag(argv, '--week'), out = flag(argv, '--out');
  if (!log || !week || !out) { console.error('usage: weekly-counts.ts --log <miss-log.jsonl> --week <YYYY-MM-DD> --out <weekly.json>'); return 2; }
  try {
    const entries = parseMissLog(readFileSync(log, 'utf8'));
    const counts = weeklyCounts(entries, week);
    writeFileSync(out, checkMissExport(counts, missNeedles(entries)));
    console.log('miss-mining: weekly counts ' + out + ' (' + counts.n_entries + ' entries, week ' + counts.week_start + ' to ' + counts.week_end + ')');
    return 0;
  } catch (error) {
    if (!(error instanceof MissMiningRefusal)) throw error;
    console.error('miss-mining: REFUSED ' + error.message + '; nothing was written (docs/benchmarks/miss-mining/README.md#' + error.code.toLowerCase() + ')');
    return 3;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

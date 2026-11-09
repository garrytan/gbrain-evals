#!/usr/bin/env bun
/**
 * Turn the private miss log into a private live-recall question file, so real
 * misses become gold retrieval questions that run through the batch 3 protocol
 * on the box (eval/runner/live-recall/run.ts freeze and run --protocol batch3).
 * The question file stays on the box; the terminal gets a custody-checked
 * summary of counts only.
 *
 *   bun eval/runner/miss-mining/to-live-recall.ts --log <miss-log.jsonl> --out <questions.jsonl>
 *
 * An entry becomes a question only when it carries the ask in both forms. Its
 * type is its live_type, else freshness for a stale_fact miss with stale pages,
 * entity for a wrong_entity miss, time_window for a time-window ask, and topic
 * otherwise. A freshness question with no stale page is skipped and counted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseQuestions } from '../live-recall/run.ts';
import { ALL_TYPES, type QType } from '../live-recall/scorecard.ts';
import { CONVERT_SCHEMA, checkMissExport } from './custody.ts';
import { MissMiningRefusal, missNeedles, parseMissLog, type MissEntry } from './schema.ts';

export function liveTypeFor(e: MissEntry): QType {
  if (e.live_type) return e.live_type;
  if (e.cause === 'stale_fact' && e.stale?.length) return 'freshness';
  if (e.cause === 'wrong_entity') return 'entity';
  if (e.ask_kind === 'time_window') return 'time_window';
  return 'topic';
}

export function toLiveRecall(entries: MissEntry[]) {
  const lines: string[] = [];
  const skipped = { no_ask: 0, freshness_without_stale: 0 };
  const skippedIds: string[] = [];
  const byType = Object.fromEntries(ALL_TYPES.map(t => [t, 0])) as Record<QType, number>;
  for (const e of entries) {
    const type = liveTypeFor(e);
    const reason = !e.ask ? 'no_ask' : type === 'freshness' && !e.stale?.length ? 'freshness_without_stale' : null;
    if (reason) {
      skipped[reason] += 1;
      skippedIds.push(e.id);
      continue;
    }
    byType[type] += 1;
    lines.push(JSON.stringify({ id: e.id, type, forms: e.ask, gold: e.gold, gold_found_by: 'unknown', ...(type === 'freshness' ? { stale: e.stale } : {}) }));
  }
  const text = lines.length ? lines.join('\n') + '\n' : '';
  if (lines.length) parseQuestions(text, 'batch3');
  return { text, summary: { schema: CONVERT_SCHEMA, converted: lines.length, skipped, by_type: byType, skipped_ids: skippedIds } };
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv: string[]): number {
  const log = flag(argv, '--log'), out = flag(argv, '--out');
  if (!log || !out) { console.error('usage: to-live-recall.ts --log <miss-log.jsonl> --out <questions.jsonl>'); return 2; }
  try {
    const entries = parseMissLog(readFileSync(log, 'utf8'));
    const { text, summary } = toLiveRecall(entries);
    const checked = checkMissExport(summary, missNeedles(entries));
    writeFileSync(out, text, { mode: 0o600 });
    console.log('miss-mining: private question file ' + out + ' (stays on this box)');
    console.log(checked.trimEnd());
    return 0;
  } catch (error) {
    if (!(error instanceof MissMiningRefusal)) throw error;
    console.error('miss-mining: REFUSED ' + error.message + '; nothing was written (docs/benchmarks/miss-mining/README.md#' + error.code.toLowerCase() + ')');
    return 3;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

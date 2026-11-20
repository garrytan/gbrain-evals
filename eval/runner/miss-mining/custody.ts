/**
 * Custody check for anything the miss-mining kit sends off the box (gate change
 * F1). It works the way the live-recall scorecard's validateScorecard does:
 * every key must be one the export formats define, every string must be an
 * allowlisted word (a cause id, an ask kind, a detection mode, a live-recall
 * type, a schema name) or match a fixed id or date pattern, every number must be
 * finite, and no string may run past 42 characters. A person's name or a
 * codename has no field it could land in. Then scanForLeaks searches the
 * serialised export for every slug and ask text in the private miss log.
 * Refusals name only the path, never the content.
 */
import { ALL_TYPES } from '../live-recall/scorecard.ts';
import { LiveRecallAbort } from '../live-recall/brain.ts';
import { scanForLeaks } from '../live-recall/scorecard.ts';
import { CAUSE_IDS, PRIVACY_SUBCAUSES } from '../predictive/causes.ts';
import { ASK_KINDS, DETECTION_MODES, MISS_ID, MissMiningRefusal } from './schema.ts';

export const MAX_STRING = 42;
export const WEEKLY_SCHEMA = 'miss-weekly-counts/v1';
export const CONVERT_SCHEMA = 'miss-to-live-recall/v1';
export const SKIP_REASONS = ['no_ask', 'freshness_without_stale'] as const;

const VOCABULARY = [...CAUSE_IDS, ...PRIVACY_SUBCAUSES, ...ASK_KINDS, ...DETECTION_MODES, ...ALL_TYPES, ...SKIP_REASONS] as const;
const KEYS = new Set<string>(['schema', 'week_start', 'week_end', 'n_entries', 'counts', 'converted', 'skipped', 'by_type', 'skipped_ids', ...VOCABULARY]);
const WORDS = new Set<string>([WEEKLY_SCHEMA, CONVERT_SCHEMA, ...VOCABULARY]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Shapes allowed only at one path. */
const FIELD_PATTERNS: Array<[RegExp, RegExp]> = [
  [/^\$\.week_(start|end)$/, ISO_DATE],
  [/^\$\.skipped_ids\[\d+\]$/, MISS_ID],
];

/** Structural check: known keys, allowlisted strings or path-bound id and date shapes, at most 42 characters, finite numbers. */
export function validateMissExport(value: unknown, path = '$'): void {
  const leak = (what: string) => new MissMiningRefusal('MM_CUSTODY_LEAK', what + ' at ' + path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw leak('non-finite number');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) throw leak('string over ' + MAX_STRING + ' characters');
    if (WORDS.has(value) || FIELD_PATTERNS.some(([at, shape]) => at.test(path) && shape.test(value))) return;
    throw leak('unexpected string');
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => validateMissExport(v, path + '[' + i + ']'));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!KEYS.has(k)) throw new MissMiningRefusal('MM_CUSTODY_LEAK', 'unexpected key under ' + path);
      validateMissExport(v, path + '.' + k);
    }
    return;
  }
  throw leak('unexpected value type');
}

/**
 * Both checks on an export and its serialised text; returns the text to write. A needle that is itself one of the
 * formats' words (a slug named like a cause id) cannot be told apart from the format and is not scanned; the
 * structure check already limits where it could appear.
 */
export function checkMissExport(value: unknown, needles: Iterable<string>): string {
  validateMissExport(value);
  const text = JSON.stringify(value, null, 2) + '\n';
  try {
    scanForLeaks(text, [...needles].filter(n => !WORDS.has(n) && !KEYS.has(n)));
  } catch (error) {
    if (error instanceof LiveRecallAbort) throw new MissMiningRefusal('MM_CUSTODY_LEAK', 'a private string from the miss log matched the export');
    throw error;
  }
  return text;
}

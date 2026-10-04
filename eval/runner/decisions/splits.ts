/**
 * Dev / sealed splits for public conversation benchmarks.
 *
 * Splits are by whole conversation (never by question, so a sealed
 * conversation's sessions never appear in dev), ordered by
 * SHA-256(salt, NUL, conversation id) ascending, and fixed before any system
 * ran on the data. The first `dev_fraction` (rounded up) are dev; the rest
 * are sealed. LongMemEval-S is development data in full: its configuration
 * was chosen on all of its questions, and re-splitting cannot undo that.
 *
 * Dev splits are open to plan authors for iteration. Sealed splits are read
 * only by the custodian at a preregistered decision, report aggregates until
 * they retire, and count every opening (eval/decisions/splits/*.json).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SPLIT_SALT = 'gbrain-evals-heldout-split-v1';
export const SPLITS_DIR = resolve(import.meta.dir, '../../decisions/splits');

export interface SplitFile {
  schema_version: 1;
  benchmark: string;
  salt: string;
  method: string;
  dev_fraction: number;
  /** Conversation ids. */
  dev: string[];
  sealed: string[];
  created_at: string;
  note: string;
}

export function splitOrder(ids: readonly string[], salt = SPLIT_SALT): string[] {
  const key = (id: string) => createHash('sha256').update(`${salt}\u0000${id}`).digest('hex');
  return [...ids].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : 1));
}

export function computeSplit(benchmark: string, conversationIds: readonly string[], devFraction: number, note: string): SplitFile {
  if (!(devFraction > 0 && devFraction <= 1)) throw new Error('dev fraction must be in (0, 1]');
  const ordered = splitOrder(conversationIds);
  const nDev = Math.ceil(ordered.length * devFraction);
  return {
    schema_version: 1, benchmark, salt: SPLIT_SALT,
    method: 'whole conversations ordered by sha256(salt, NUL, conversation id) ascending; first ceil(n * dev_fraction) are dev',
    dev_fraction: devFraction, dev: ordered.slice(0, nDev).sort(), sealed: ordered.slice(nDev).sort(), created_at: new Date().toISOString().slice(0, 10), note,
  };
}

export function loadSplit(benchmark: string): SplitFile {
  const path = join(SPLITS_DIR, `${benchmark}.json`);
  if (!existsSync(path)) throw new Error(`no split file for ${benchmark} at ${path}`);
  const s = JSON.parse(readFileSync(path, 'utf8')) as SplitFile;
  if (s.schema_version !== 1 || s.benchmark !== benchmark) throw new Error(`${path} is not a split file for ${benchmark}`);
  const overlap = s.dev.filter(id => s.sealed.includes(id));
  if (overlap.length) throw new Error(`${path}: ${overlap.length} conversations are in both dev and sealed`);
  return s;
}

/** Conversation ids a dev run may read. The fixture has no split file and is all dev. */
export function devConversations(benchmark: string): Set<string> | null {
  if (benchmark === 'fixture') return null;
  return new Set(loadSplit(benchmark).dev);
}

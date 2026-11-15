/**
 * The sealed-id guard for everything the SOTA loop writes: answerability files, outcome-cache rows, fix lists,
 * attribution, ledger and scorecard outputs, and their drive exports. Sealed conversations stay in custody, so their ids
 * must never reach a public file or a drive file a public file could be built from.
 *
 * The sealed ids are every string id a split file lists as sealed (eval/decisions/splits/*.json, beam-rs1.json and
 * bg1.json included), plus the question ids a split file excludes. An id matches as a whole token: "1m-1" matches
 * "1m-1" and "1m-1:abstention:0" but not "1m-16". Numeric seeds (hub-world's sealed_seeds) are not ids a text could be
 * told apart by, so they are left out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SPLITS_DIR = resolve(import.meta.dir, '../../decisions/splits');

export class SealedIdError extends Error {}

let cached: { ids: string[]; pattern: RegExp } | null = null;

/** Every sealed string id across the split files, sorted. */
export function sealedIds(dir = SPLITS_DIR): string[] {
  const ids = new Set<string>();
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const split = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sealed?: unknown[]; exclusions?: Array<{ question?: unknown }> };
    for (const id of split.sealed ?? []) if (typeof id === 'string' && id.trim()) ids.add(id);
    for (const e of split.exclusions ?? []) if (typeof e.question === 'string') ids.add(e.question);
  }
  return [...ids].sort();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(dir: string): RegExp {
  if (dir === SPLITS_DIR && cached) return cached.pattern;
  const ids = sealedIds(dir).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(${ids.map(escape).join('|')})(?![A-Za-z0-9_-])`, 'g');
  if (dir === SPLITS_DIR) cached = { ids, pattern };
  return pattern;
}

/** The sealed ids a text holds, each once, in order of first appearance. */
export function findSealedIds(text: string, dir = SPLITS_DIR): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(matcher(dir))) hits.add(m[1]!);
  return [...hits];
}

/** Refuses a text that holds a sealed id, naming only how many and where (never the ids, which are themselves custody facts). */
export function assertNoSealedIds(text: string, where: string, dir = SPLITS_DIR): void {
  const hits = findSealedIds(text, dir);
  if (hits.length) throw new SealedIdError(`SOTA_SEALED_ID: ${where} holds ${hits.length} sealed id${hits.length === 1 ? '' : 's'} from eval/decisions/splits; sealed rows stay in custody`);
}

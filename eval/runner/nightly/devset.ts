/**
 * The nightly development set: a frozen, versioned list of suites and items, chosen for headroom.
 *
 * A night is compared with an earlier night only suite by suite, and only where the suite digest matches, so adding
 * a suite (the Wintermute gap-map generators, mined real misses) never resets the history of the others. Changing a
 * suite's items or config changes its digest and starts a new baseline for that suite.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The current dev set. devset-v1.json stays committed: nights recorded before v2 name it, and its suites' digests are theirs. */
export const DEVSET_PATH = 'eval/data/nightly/devset-v2.json';
export const DEVSET_FIX = `fix: bun eval/runner/nightly/select-devset.ts && git diff ${DEVSET_PATH}`;

export interface Item { id: string; role: 'headroom' | 'canary' }
export interface Suite {
  id: string;
  kind: 'agent' | 'qa' | 'replay' | 'trials' | 'smoke';
  scoring: 'deterministic' | 'judge';
  about: string;
  source: string;
  config?: Record<string, unknown>;
  /** A ref that lacks this commit skips the suite and the report says why. */
  requires?: { gbrain_commit: string };
  items: Item[];
  note?: string;
}
export interface DevSet {
  version: number;
  readers: string[];
  k: Record<Suite['kind'], number>;
  suites: Suite[];
  reserved: string[];
  digest: string;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as any)[k])])) : v;

export const canonicalDigest = (v: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(v))).digest('hex');
export const suiteDigest = (s: Suite) => canonicalDigest(s);

export function loadDevSet(root = resolve(import.meta.dir, '../../..'), path = DEVSET_PATH): DevSet {
  const set = JSON.parse(readFileSync(join(root, path), 'utf8')) as DevSet;
  const { digest, ...body } = set;
  if (canonicalDigest(body) !== digest) throw new Error(`DEVSET_DIGEST_MISMATCH: ${path} was edited without a rebuild; ${DEVSET_FIX}`);
  return set;
}

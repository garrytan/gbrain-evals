/**
 * Predictive validity: does a synthetic measure rank gbrain versions and
 * configurations the way the real brain does? A measure gates nothing until it
 * reads PREDICTIVE against real reference contrasts named in its
 * preregistration.
 *
 * Rule (preregistered):
 * - A reference contrast qualifies when its real 95% interval excludes zero.
 * - Fewer than minQualifying qualifying contrasts (default 3) reads NO_REFERENCE_YET.
 * - PREDICTIVE needs the synthetic estimate to share the sign of every qualifying
 *   contrast, and no mapped synthetic contrast whose interval excludes zero may
 *   point the other way from its reference estimate.
 * - Kendall's tau over a shared configuration ordering is reported, never gating.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const VERDICTS = ['PREDICTIVE', 'NOT_PREDICTIVE', 'NO_REFERENCE_YET'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const DEFAULT_MIN_QUALIFYING = 3;

export interface Contrast {
  id: string;
  estimate: number;
  lo: number;
  hi: number;
}

export interface ReferenceFile {
  id: string;
  source: string;
  contrasts: Contrast[];
  orderings?: Record<string, string[]>;
}

export interface ManifestEntry {
  id: string;
  file: string;
  sha256?: string;
  status: 'available' | 'pending';
}

export class ValidityReferenceError extends Error {
  readonly code = 'VALIDITY_REFERENCE_INVALID';
  constructor(readonly path: string, detail: string, readonly expected?: string, readonly actual?: string) {
    super(`${detail} (${path}${expected ? `; expected sha256 ${expected}, actual ${actual ?? 'none'}` : ''}); fix: restore the file from git or rerun the export that wrote it, then update eval/data/validity-references/manifest.json (VALIDITY_REFERENCE_INVALID)`);
  }
}

function checkContrast(value: unknown, path: string): Contrast {
  const c = value as Contrast;
  if (!c || typeof c.id !== 'string' || ![c.estimate, c.lo, c.hi].every(Number.isFinite) || c.lo > c.hi) {
    throw new ValidityReferenceError(path, `malformed contrast ${JSON.stringify(value)}`);
  }
  return { id: c.id, estimate: c.estimate, lo: c.lo, hi: c.hi };
}

/** Loads one reference. A pending reference returns null; anything missing, corrupt or off-digest throws. */
export function loadReference(manifestPath: string, id: string): ReferenceFile | null {
  if (!existsSync(manifestPath)) throw new ValidityReferenceError(manifestPath, 'reference manifest missing');
  let manifest: ManifestEntry[];
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new ValidityReferenceError(manifestPath, 'reference manifest is not JSON');
  }
  const entry = Array.isArray(manifest) ? manifest.find((m) => m.id === id) : undefined;
  if (!entry) throw new ValidityReferenceError(manifestPath, `reference ${id} is not listed`);
  if (entry.status === 'pending') return null;
  const path = join(dirname(manifestPath), entry.file);
  if (!existsSync(path)) throw new ValidityReferenceError(path, `reference ${id} is listed as available but missing`, entry.sha256);
  const bytes = readFileSync(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!entry.sha256 || actual !== entry.sha256) throw new ValidityReferenceError(path, `reference ${id} digest mismatch`, entry.sha256, actual);
  let parsed: ReferenceFile;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ValidityReferenceError(path, `reference ${id} is not JSON`, entry.sha256, actual);
  }
  if (parsed.id !== id || typeof parsed.source !== 'string' || !Array.isArray(parsed.contrasts)) {
    throw new ValidityReferenceError(path, `reference ${id} has the wrong shape`);
  }
  return { ...parsed, contrasts: parsed.contrasts.map((c) => checkContrast(c, path)) };
}

const excludesZero = (c: Contrast) => c.lo > 0 || c.hi < 0;

export interface VerdictInput {
  /** Reference contrast ids this measure is compared with, from its preregistration. */
  mapped: string[];
  reference: ReferenceFile | null;
  synthetic: Contrast[];
  minQualifying?: number;
  ordering?: { key: string; synthetic: string[] };
}

export interface VerdictResult {
  verdict: Verdict;
  qualifying: string[];
  agree: string[];
  disagree: string[];
  kendall_tau: number | null;
}

export function kendallTau(a: string[], b: string[]): number | null {
  const shared = a.filter((x) => b.includes(x));
  if (shared.length < 2) return null;
  const rankB = new Map(b.map((x, i) => [x, i]));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const d = (rankB.get(shared[i])! - rankB.get(shared[j])!) * (i - j);
      if (d > 0) concordant += 1;
      else if (d < 0) discordant += 1;
    }
  }
  return (concordant - discordant) / ((shared.length * (shared.length - 1)) / 2);
}

export function verdict(input: VerdictInput): VerdictResult {
  const min = input.minQualifying ?? DEFAULT_MIN_QUALIFYING;
  if (!Number.isInteger(min) || min < 1) throw new Error('minQualifying must be a positive integer');
  const empty: VerdictResult = { verdict: 'NO_REFERENCE_YET', qualifying: [], agree: [], disagree: [], kendall_tau: null };
  if (!input.reference) return empty;
  const refById = new Map(input.reference.contrasts.map((c) => [c.id, c]));
  const synById = new Map(input.synthetic.map((c) => [c.id, c]));
  for (const id of input.mapped) {
    if (!refById.has(id)) throw new Error(`preregistered contrast ${id} is not in reference ${input.reference.id}`);
  }
  const qualifying = input.mapped.filter((id) => excludesZero(refById.get(id)!));
  const tauRef = input.ordering ? input.reference.orderings?.[input.ordering.key] : undefined;
  const kendall_tau = input.ordering && tauRef ? kendallTau(input.ordering.synthetic, tauRef) : null;
  if (qualifying.length < min) return { ...empty, qualifying, kendall_tau };
  const agree: string[] = [];
  const disagree: string[] = [];
  for (const id of input.mapped) {
    const ref = refById.get(id)!;
    const syn = synById.get(id);
    if (!syn) throw new Error(`synthetic result has no contrast ${id}`);
    const qualifies = qualifying.includes(id);
    const sameSign = Math.sign(syn.estimate) === Math.sign(ref.estimate) && syn.estimate !== 0;
    const opposedSignificant = excludesZero(syn) && Math.sign(syn.estimate) === -Math.sign(ref.estimate) && ref.estimate !== 0;
    if (opposedSignificant || (qualifies && !sameSign)) disagree.push(id);
    else if (qualifies) agree.push(id);
  }
  return { verdict: disagree.length === 0 ? 'PREDICTIVE' : 'NOT_PREDICTIVE', qualifying, agree, disagree, kendall_tau };
}

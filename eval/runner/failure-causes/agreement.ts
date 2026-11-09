/**
 * The labeller check (R78 style, applied to the residual labeller). The label
 * set is the rows Opus 5.5 and GPT-6 Astra, both at high effort, label the same
 * way, stratified by labeller path and source, and split by a hash of the case
 * key into a development part (for prompt work) and a held-out part (for the
 * gate). Each production path gates on Cohen's kappa of at least 0.6 against
 * the held-out agreed labels, with at least 40 of them.
 */
import { createHash } from 'node:crypto';

export const KAPPA_MIN = 0.6;
export const MIN_AGREED_PER_PATH = 40;

export interface DoubleLabel { case_key: string; path: string; stratum: string; opus: string; astra: string }
export interface LabelSetRow { case_key: string; path: string; stratum: string; label: string; split: 'dev' | 'held_out' }

const unit = (key: string) => parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0xffffffff;

export function buildLabelSet(rows: DoubleLabel[], heldOutShare = 0.5): { rows: LabelSetRow[]; agreed: number; disagreed: number } {
  const agreed = rows.filter(r => r.opus === r.astra);
  return {
    rows: agreed.map(r => ({ case_key: r.case_key, path: r.path, stratum: r.stratum, label: r.opus, split: unit(r.case_key) < heldOutShare ? 'held_out' : 'dev' })),
    agreed: agreed.length, disagreed: rows.length - agreed.length,
  };
}

/** Deterministic stratified sample: within each stratum, the n cases with the smallest key hash. */
export function stratifiedSample<T>(items: T[], stratum: (t: T) => string, key: (t: T) => string, perStratum: number): T[] {
  const groups = new Map<string, T[]>();
  for (const t of items) groups.set(stratum(t), [...(groups.get(stratum(t)) ?? []), t]);
  return [...groups.values()].flatMap(g => [...g].sort((a, b) => unit(key(a)) - unit(key(b))).slice(0, perStratum));
}

export function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (!n) return null;
  const labels = [...new Set(pairs.flat())];
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = labels.reduce((s, l) => s + (pairs.filter(([a]) => a === l).length / n) * (pairs.filter(([, b]) => b === l).length / n), 0);
  return expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
}

export function confusion(pairs: ReadonlyArray<readonly [string, string]>): { labels: string[]; rows: Record<string, Record<string, number>> } {
  const labels = [...new Set(pairs.flat())].sort();
  const rows: Record<string, Record<string, number>> = Object.fromEntries(labels.map(l => [l, Object.fromEntries(labels.map(m => [m, 0]))]));
  for (const [truth, got] of pairs) rows[truth][got]++;
  return { labels, rows };
}

export function perCause(pairs: ReadonlyArray<readonly [string, string]>): Record<string, { support: number; precision: number | null; recall: number | null }> {
  const labels = [...new Set(pairs.flat())].sort();
  return Object.fromEntries(labels.map(l => {
    const tp = pairs.filter(([t, g]) => t === l && g === l).length;
    const predicted = pairs.filter(([, g]) => g === l).length;
    const support = pairs.filter(([t]) => t === l).length;
    return [l, { support, precision: predicted ? tp / predicted : null, recall: support ? tp / support : null }];
  }));
}

export interface PathGate { path: string; held_out: number; kappa: number | null; pass: boolean; reason: string; confusion: ReturnType<typeof confusion>; per_cause: ReturnType<typeof perCause> }

/** Gate each production path on its held-out agreed rows. production maps case_key to the production labeller's cause. */
export function gatePaths(set: LabelSetRow[], production: ReadonlyMap<string, string>): PathGate[] {
  const paths = [...new Set(set.map(r => r.path))].sort();
  return paths.map(path => {
    const held = set.filter(r => r.path === path && r.split === 'held_out' && production.has(r.case_key));
    const pairs = held.map(r => [r.label, production.get(r.case_key)!] as const);
    const kappa = cohensKappa(pairs);
    const enough = held.length >= MIN_AGREED_PER_PATH;
    const pass = enough && kappa !== null && kappa >= KAPPA_MIN;
    const reason = !enough ? `${held.length} held-out agreed rows, under ${MIN_AGREED_PER_PATH}` : pass ? `kappa ${kappa!.toFixed(3)} >= ${KAPPA_MIN}` : `kappa ${kappa?.toFixed(3)} < ${KAPPA_MIN}: switch this path to Astra`;
    return { path, held_out: held.length, kappa, pass, reason, confusion: confusion(pairs), per_cause: perCause(pairs) };
  });
}

/** Known-answer control: share of masked deterministic cases the labeller gave their deterministic cause. */
export function knownAnswerAccuracy(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  return pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : null;
}

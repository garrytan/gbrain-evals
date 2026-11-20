/**
 * The labeller check (R78 style, applied to the residual labeller). The label
 * set is the rows Opus 5.5 and GPT-6 Astra, both at high effort, label the same
 * way, sampled per row family (the family of the model that answered) and
 * source, and split by a second, salted hash of the case key into a development
 * part (for prompt work) and a held-out part (for the gate), so the split does
 * not follow the sample order. Each production labeller path gates, per row
 * family it labelled, on Cohen's kappa of at least 0.6 against the held-out
 * agreed labels, with at least 40 of them. A family switched to the Astra
 * fallback gates the same way, against the same family's rows. report refuses
 * model labels from a path and family with no passing gate (ungated).
 */
import { createHash } from 'node:crypto';
import type { CauseLabel } from './types.ts';

export const KAPPA_MIN = 0.6;
/** A labeller call that failed or whose reply did not parse: no label, so it waits for a rerun. */
export const NO_LABEL_RULES: readonly string[] = ['labeller.call_failed', 'labeller.invalid_reply'];
export const MIN_AGREED_PER_PATH = 40;

/** path is the row family: the default production path for the family of the model that answered (labellerFor). */
export interface DoubleLabel { case_key: string; path: string; stratum: string; opus: string; astra: string }
export interface LabelSetRow { case_key: string; path: string; stratum: string; label: string; split: 'dev' | 'held_out' }

const unit = (key: string) => parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0xffffffff;
const splitUnit = (key: string) => unit(`split|${key}`);
/** Agreed rows needed before a family can reach MIN_AGREED_PER_PATH held-out rows: half are held out, and about 80% agree. */
export const LABEL_SET_PER_FAMILY = Math.ceil(MIN_AGREED_PER_PATH / 0.5 / 0.8);

export function buildLabelSet(rows: DoubleLabel[], heldOutShare = 0.5): { rows: LabelSetRow[]; agreed: number; disagreed: number } {
  const agreed = rows.filter(r => r.opus === r.astra);
  return {
    rows: agreed.map(r => ({ case_key: r.case_key, path: r.path, stratum: r.stratum, label: r.opus, split: splitUnit(r.case_key) < heldOutShare ? 'held_out' : 'dev' })),
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

/** One labeller path on one row family. family is the family's default production path, as in DoubleLabel.path. */
export interface PathGate { path: string; family: string; held_out: number; kappa: number | null; pass: boolean; reason: string; confusion: ReturnType<typeof confusion>; per_cause: ReturnType<typeof perCause> }
export interface Production { byCase: Map<string, { cause: string; path: string }>; pairs: Array<{ path: string; family: string }> }

/**
 * The production labeller's cause and path per case key, and every (labeller path, row family) pair the production
 * labels used. family(model) names the row family (in the CLI, labellerFor(model).path). A failed call or an
 * unparseable reply is no label, so it never counts toward agreement, but its pair still needs a gate.
 */
export function productionLabels(labels: CauseLabel[], family: (model: string) => string): Production {
  const labelled = labels.filter(l => (l.basis === 'model' || l.basis === 'unclassified') && l.labeller);
  const answered = labelled.filter(l => !NO_LABEL_RULES.includes(l.rule_id));
  const pairs = new Map(labelled.map(l => [`${l.labeller!.path}@${family(l.model)}`, { path: l.labeller!.path, family: family(l.model) }]));
  return { byCase: new Map(answered.map(l => [`${l.source}|${l.case_id}`, { cause: String(l.cause), path: l.labeller!.path }])),
    pairs: [...pairs.values()].sort((a, b) => `${a.path}@${a.family}`.localeCompare(`${b.path}@${b.family}`)) };
}

/**
 * Gate each (production path, row family) pair on the family's held-out agreed rows that this path labelled in
 * production. Every pair the production labels used gets a gate, so a path with no label-set rows fails instead of
 * going ungated.
 */
export function gatePaths(set: LabelSetRow[], production: Production): PathGate[] {
  return production.pairs.map(({ path, family }) => {
    const held = set.filter(r => r.path === family && r.split === 'held_out' && production.byCase.get(r.case_key)?.path === path);
    const pairs = held.map(r => [r.label, production.byCase.get(r.case_key)!.cause] as const);
    const kappa = cohensKappa(pairs);
    const enough = held.length >= MIN_AGREED_PER_PATH;
    const pass = enough && kappa !== null && kappa >= KAPPA_MIN;
    const reason = !enough ? `${held.length} held-out agreed rows, under ${MIN_AGREED_PER_PATH}` : pass ? `kappa ${kappa!.toFixed(3)} >= ${KAPPA_MIN}` : `kappa ${kappa?.toFixed(3)} < ${KAPPA_MIN}: switch this family to Astra and gate again`;
    return { path, family, held_out: held.length, kappa, pass, reason, confusion: confusion(pairs), per_cause: perCause(pairs) };
  });
}

/**
 * The model labels a report may not count: every model or labeller-unclassified label whose (path, family) has no
 * passing gate. family(model) is the same mapping productionLabels used.
 */
export function ungated(labels: CauseLabel[], gates: ReadonlyArray<Pick<PathGate, 'path' | 'family' | 'pass'>>, family: (model: string) => string): Array<{ path: string; family: string; labels: number }> {
  const passed = new Set(gates.filter(g => g.pass).map(g => `${g.path}@${g.family}`));
  const missing = new Map<string, { path: string; family: string; labels: number }>();
  for (const l of labels) {
    if (!l.labeller || NO_LABEL_RULES.includes(l.rule_id)) continue;
    const key = `${l.labeller.path}@${family(l.model)}`;
    if (passed.has(key)) continue;
    const m = missing.get(key) ?? { path: l.labeller.path, family: family(l.model), labels: 0 };
    m.labels++;
    missing.set(key, m);
  }
  return [...missing.values()];
}

/** The label-set sample: per row family, about perFamily residuals spread evenly over the family's sources. */
export function labelSetSample<T>(items: T[], family: (t: T) => string, source: (t: T) => string, key: (t: T) => string, perFamily = LABEL_SET_PER_FAMILY): T[] {
  const families = new Map<string, Set<string>>();
  for (const t of items) families.set(family(t), (families.get(family(t)) ?? new Set()).add(source(t)));
  return [...families].flatMap(([fam, sources]) => stratifiedSample(items.filter(t => family(t) === fam), source, key, Math.ceil(perFamily / sources.size)));
}

/** Known-answer control: share of masked deterministic cases the labeller gave their deterministic cause. */
export function knownAnswerAccuracy(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  return pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : null;
}

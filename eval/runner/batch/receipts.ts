/**
 * Receipts and offline scoring for batch arms. Rows join by question id,
 * never by order. Generation and judging are recorded separately:
 *
 * - a reader row is an error (and wrong) when its request failed, expired,
 *   went missing, finished at the output limit or returned no text;
 * - a judge verdict is "yes" in the lowercased reply (the official rule); a
 *   judge request that failed or returned nothing is a judge error, which
 *   counts as incorrect and is reported;
 * - every manifest question is in the denominator.
 */
import type { ComparisonFamily } from '../stats/gates.ts';
import type { ArmManifest } from './manifest.ts';
import { judgeVerdict, reportType } from './sources.ts';
import type { StoredResult } from './submit.ts';

export interface ReaderRow {
  question_id: string;
  question_type: string;
  arm_id: string;
  model: string;
  hypothesis: string;
  finish: string | null;
  /** null, or why the row counts as wrong without a judge: reader_max_tokens, reader_empty_response, reader_<status>. */
  error: string | null;
  response_model: string | null;
  usage: Record<string, unknown> | null;
  usd: number;
  list_usd: number;
  intent_id: string | null;
}

export function readerRows(manifest: ArmManifest, results: Map<string, StoredResult>, types: Map<string, string>): ReaderRow[] {
  return manifest.requests.map(({ question_id }) => {
    const r = results.get(question_id);
    const type = types.get(question_id) ?? 'unknown';
    const base = { question_id, question_type: type, arm_id: manifest.arm_id, model: manifest.model };
    if (!r) return { ...base, hypothesis: '', finish: null, error: 'reader_not_run', response_model: null, usage: null, usd: 0, list_usd: 0, intent_id: null };
    const text = (r.text ?? '').trim();
    const error = r.status !== 'succeeded' ? `reader_${r.status}` : r.finish === 'max_tokens' ? 'reader_max_tokens' : r.finish !== 'stop' ? 'reader_unknown_finish_reason' : text === '' ? 'reader_empty_response' : null;
    return { ...base, hypothesis: error ? '' : text, finish: r.finish, error, response_model: r.response_model, usage: r.usage, usd: r.usd, list_usd: r.list_usd, intent_id: r.intent_id };
  });
}

export interface JudgeOutcome { verdict: boolean | null; raw: string | null; error: string | null }

export function judgeOutcome(r: StoredResult | undefined): JudgeOutcome {
  if (!r) return { verdict: null, raw: null, error: 'judge_not_run' };
  if (r.status !== 'succeeded') return { verdict: null, raw: null, error: `judge_${r.status}` };
  const raw = (r.text ?? '').trim();
  if (r.finish === 'max_tokens' && raw === '') return { verdict: null, raw, error: 'judge_max_tokens' };
  if (raw === '') return { verdict: null, raw, error: 'judge_empty_response' };
  return { verdict: judgeVerdict(raw), raw, error: null };
}

export interface ScoredRow {
  question_id: string;
  question_type: string;
  arm_id: string;
  correct_official: 0 | 1;
  correct_secondary: 0 | 1 | null;
  official: JudgeOutcome | { verdict: false; raw: null; error: 'reader_error' };
  secondary: JudgeOutcome | { verdict: false; raw: null; error: 'reader_error' } | null;
  reader_error: string | null;
}

/** Score reader rows with the two judges. Reader errors are wrong under both judges and are not sent to a judge. */
export function scoreRows(rows: ReaderRow[], official: Map<string, StoredResult>, secondary: Map<string, StoredResult> | null): ScoredRow[] {
  return rows.map(r => {
    const readerError = { verdict: false as const, raw: null, error: 'reader_error' as const };
    const o = r.error ? readerError : judgeOutcome(official.get(r.question_id));
    const s = secondary === null ? null : r.error ? readerError : judgeOutcome(secondary.get(r.question_id));
    return {
      question_id: r.question_id, question_type: r.question_type, arm_id: r.arm_id,
      correct_official: o.verdict === true ? 1 : 0,
      correct_secondary: s === null ? null : s.verdict === true ? 1 : 0,
      official: o, secondary: s, reader_error: r.error,
    };
  });
}

export interface ArmSummary {
  arm_id: string;
  denominator: number;
  correct_official: number;
  correct_secondary: number | null;
  judge_agreement: number | null;
  reader_errors: Record<string, number>;
  judge_errors: { official: number; secondary: number | null };
  finish_counts: Record<string, number>;
  max_tokens_finishes: number;
  by_type: Record<string, { total: number; official: number; secondary: number | null }>;
  usd: number;
  list_usd: number;
}

export function summarize(manifest: ArmManifest, rows: ReaderRow[], scored: ScoredRow[]): ArmSummary {
  const count = <T extends string>(xs: (T | null)[]) => xs.reduce((m, x) => (x === null ? m : { ...m, [x]: (m[x] ?? 0) + 1 }), {} as Record<string, number>);
  const hasSecondary = scored.some(s => s.correct_secondary !== null);
  const byType: ArmSummary['by_type'] = {};
  for (const s of scored) {
    const t = byType[s.question_type] ??= { total: 0, official: 0, secondary: hasSecondary ? 0 : null };
    t.total++;
    t.official += s.correct_official;
    if (t.secondary !== null) t.secondary += s.correct_secondary ?? 0;
  }
  const judged = scored.filter(s => !s.reader_error && s.official.error === null && s.secondary && s.secondary.error === null);
  return {
    arm_id: manifest.arm_id, denominator: manifest.denominator,
    correct_official: scored.reduce((a, s) => a + s.correct_official, 0),
    correct_secondary: hasSecondary ? scored.reduce((a, s) => a + (s.correct_secondary ?? 0), 0) : null,
    judge_agreement: hasSecondary ? judged.filter(s => s.official.verdict === s.secondary!.verdict).length : null,
    reader_errors: count(rows.map(r => r.error)),
    judge_errors: {
      official: scored.filter(s => !s.reader_error && s.official.error !== null).length,
      secondary: hasSecondary ? scored.filter(s => !s.reader_error && s.secondary?.error !== null).length : null,
    },
    finish_counts: count(rows.map(r => r.finish ?? (r.error ? 'none' : null))),
    max_tokens_finishes: rows.filter(r => r.finish === 'max_tokens').length,
    by_type: byType,
    usd: rows.reduce((a, r) => a + r.usd, 0),
    list_usd: rows.reduce((a, r) => a + r.list_usd, 0),
  };
}

/** Pair two arms by question id; refuses unless both cover exactly the same ids (F6). */
export function pairByIds<T extends { question_id: string }>(a: T[], b: T[], expected?: string[]): [T, T][] {
  const ids = (xs: T[]) => [...new Set(xs.map(x => x.question_id))].sort();
  const ia = ids(a), ib = ids(b);
  if (ia.length !== a.length || ib.length !== b.length) throw new Error('duplicate question ids in a paired arm');
  const want = expected ? [...expected].sort() : ia;
  for (const [name, got] of [['A', ia], ['B', ib]] as const) {
    if (got.length !== want.length || got.some((x, k) => x !== want[k])) throw new Error(`arm ${name} covers ${got.length} ids, not the preregistered ${want.length}; refusing to pair mismatched id sets`);
  }
  const mb = new Map(b.map(x => [x.question_id, x]));
  return a.map((x): [T, T] => [x, mb.get(x.question_id)!]).sort(([x], [y]) => (x.question_id < y.question_id ? -1 : 1));
}

/**
 * Rows for one cross-arm family evaluation with `compare.ts --family`: A holds
 * the comparator's correctness copied into one field per arm, B each arm's
 * correctness in that field, so a single family evaluation applies Holm
 * across every arm (compare.ts adjusts only within one evaluation).
 */
export function crossArmRows(comparator: Map<string, 0 | 1>, arms: { field: string; rows: Map<string, 0 | 1> }[], ids: string[]): { a: Record<string, unknown>[]; b: Record<string, unknown>[] } {
  const a: Record<string, unknown>[] = [];
  const b: Record<string, unknown>[] = [];
  for (const id of [...ids].sort()) {
    const base = comparator.get(id);
    if (base === undefined) throw new Error(`comparator has no row for ${id}`);
    const ra: Record<string, unknown> = { question_id: id };
    const rb: Record<string, unknown> = { question_id: id };
    for (const arm of arms) {
      const v = arm.rows.get(id);
      if (v === undefined) throw new Error(`arm field ${arm.field} has no row for ${id}`);
      ra[arm.field] = base;
      rb[arm.field] = v;
    }
    a.push(ra);
    b.push(rb);
  }
  return { a, b };
}

/** A family of superiority comparisons, one per arm field, Holm-adjusted together. */
export function superiorityFamily(familyId: string, registeredAt: string, fields: string[], description: string): ComparisonFamily {
  return {
    schema_version: 1, family_id: familyId, registered_at: registeredAt, description, alpha: 0.05, seed: 20261006, draws: 10000, id_field: 'question_id',
    comparisons: fields.map(field => ({ id: `${field}-vs-comparator`, metric: field, gate: 'superiority' as const, direction: 'higher' as const, min_effect: 0, cluster_by: 'question_id' })),
  };
}

export { reportType };

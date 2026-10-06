/**
 * Fixed-sequence (hierarchical) testing for nested packages (Q2 C-gates confirmation).
 *
 * Steps are tested in their preregistered order; step j is tested only if step j-1 passed. Each step is tested at
 * the full alpha, and the family-wise error rate stays at alpha because no step is reached after a failure. This is
 * deliberately separate from stats/gates.ts, which Holm-adjusts every confirmatory comparison of a family: a fixed
 * sequence must not be Holm-adjusted, and Holm must not be applied to a sequence.
 */
export type SequenceStatus = 'pass' | 'fail' | 'not_tested';
export interface SequenceStep<T> { id: string; evaluate: () => { pass: boolean; detail: T } }
export interface SequenceResult<T> { id: string; status: SequenceStatus; detail?: T; reason?: string }

export function fixedSequence<T>(steps: ReadonlyArray<SequenceStep<T>>): { results: SequenceResult<T>[]; longest_passing_prefix: string[]; stopped_at: string | null } {
  const results: SequenceResult<T>[] = [];
  let stopped: string | null = null;
  for (const s of steps) {
    if (stopped) { results.push({ id: s.id, status: 'not_tested', reason: `${stopped} failed earlier in the sequence; later steps are never tested` }); continue; }
    const r = s.evaluate();
    results.push({ id: s.id, status: r.pass ? 'pass' : 'fail', detail: r.detail });
    if (!r.pass) stopped = s.id;
  }
  const prefix: string[] = [];
  for (const r of results) { if (r.status !== 'pass') break; prefix.push(r.id); }
  return { results, longest_passing_prefix: prefix, stopped_at: stopped };
}

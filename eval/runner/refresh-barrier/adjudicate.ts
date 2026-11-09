/**
 * Part C adjudication for the refresh write barrier preregistration
 * (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md, Amendment 3): a write refused invalid_params with
 * gbrain's "nothing was written", followed by a corrected call carrying the same fact token, counts as one write attempt
 * and its resend, not a reissue. A fact token more than once in pages or Git HEAD, or a context overflow, fails an
 * episode under both readings. scripts/refresh-barrier-partc-adjudicate.ts applies it to a whole Part C run, and the
 * failure-cause adapter reads each episode through it.
 */
type Rec = Record<string, any>;

/** Reissues the rule excuses: the latest earlier write carrying the fact was refused invalid_params and wrote nothing. */
export function excusedReissues(r: Rec): Rec[] {
  const writes: Rec[] = r.write_calls ?? [];
  return ((r.behavior?.reissues ?? []) as Rec[]).filter(x => {
    const prior = writes.filter(w => w.i < x.call && (w.tokens ?? []).includes(x.fact)).at(-1);
    return prior !== undefined && prior.code === 'invalid_params' && String(r.transcript?.[prior.i]?.result ?? '').includes('nothing was written');
  });
}

export function adjudicateEpisode(r: Rec): { raw: boolean; adjudicated: boolean; reissues: number; excused: number } {
  const reissues: Rec[] = r.behavior?.reissues ?? [];
  const excused = excusedReissues(r).length;
  const s = r.score ?? {};
  const kept = (s.duplicates ?? []).length === 0 && r.loop?.stop !== 'context_overflow';
  return { raw: s.success === true && kept, adjudicated: s.tokens_once === true && s.report_correct === true && excused === reissues.length && kept, reissues: reissues.length, excused };
}

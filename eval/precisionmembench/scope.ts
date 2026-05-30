/**
 * scope.ts — map PrecisionMemBench belief `scope` strings to gbrain source ids.
 *
 * Beliefs carry scopes like `domain:code`, `domain:writing`, `user:universal`.
 * gbrain `source_id` must match `^[a-z0-9_-]+$` (colon is illegal), so we
 * sanitize `:` → `-`. The mapping is shared by the seed path (which registers
 * sources + imports each belief under its scope) and the adapter's searchText
 * (which federates the query scope with `user:universal`), so the two cannot
 * drift.
 *
 * Scope isolation uses gbrain's REAL multi-source feature: a query in
 * `domain:code` searches sources `[domain-code, user-universal]` — universal
 * preferences surface in every domain, domain beliefs stay isolated. That is
 * exactly what the benchmark's `/search` `scope` param is asking for.
 */

export const UNIVERSAL_SOURCE = 'user-universal';

/** `domain:code` → `domain-code`. Stable, reversible enough for our needs. */
export function scopeToSourceId(scope: string): string {
  return scope.trim().toLowerCase().replace(/:/g, '-');
}

/**
 * The source-id set a query scoped to `scope` should search: the scope's own
 * source plus the universal source (deduped, universal never doubled).
 */
export function federatedSourceIds(scope: string | undefined): string[] {
  if (!scope) return [UNIVERSAL_SOURCE];
  const sid = scopeToSourceId(scope);
  return sid === UNIVERSAL_SOURCE ? [UNIVERSAL_SOURCE] : [sid, UNIVERSAL_SOURCE];
}

/** Distinct sanitized source ids referenced by a belief set (for registration). */
export function distinctSourceIds(scopes: string[][]): string[] {
  const set = new Set<string>();
  for (const arr of scopes) for (const s of arr) set.add(scopeToSourceId(s));
  return [...set];
}

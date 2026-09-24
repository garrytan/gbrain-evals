export function executedCueLookup(status: unknown, reason?: unknown): boolean {
  const bounded = ['candidate_budget', 'iterative_scan_unavailable', 'evidence_budget_incomplete'];
  if (reason !== undefined && reason !== null && !bounded.includes(String(reason))) return false;
  return status === 'ready' || status === 'empty' || (status === 'degraded' && bounded.includes(String(reason)));
}

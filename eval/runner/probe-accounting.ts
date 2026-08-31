/**
 * Probe accounting — the ONE implementation of the WS0 scoring policy.
 *
 * Twelve-plus runners previously hand-rolled error handling, each with a
 * different silent bias: errors swallowed and dropped from denominators
 * (inflates means), or judge failures averaged in as 0 (deflates means),
 * or whole runs killed by one bad probe (audit findings cat18-07, cat20-05,
 * cat25-02, cat27-08, cat29-05, cat31-02, longmemeval-02...).
 *
 * Policy (WS0, one place, no per-runner wording drift):
 *   - failure_origin = 'sut'        → the system under test failed the probe:
 *                                     scored as a MISS (0) in primary metrics.
 *                                     Excluding it would reward adapters that
 *                                     crash on hard probes.
 *   - 'harness' | 'dependency'      → our bug / external outage: excluded from
 *                                     means, recorded, capped.
 *   - 'judge'                       → judge_failed: excluded from means,
 *                                     recorded, capped with the same rule.
 *   - Cap: when n_total >= 10, a (harness+dependency+judge) error rate > 10%
 *     invalidates the run (runInvalid → exit non-zero). Smoke runs
 *     (n_total < 10) with ANY such error are publishable:false instead —
 *     a 1-probe smoke run must not be "invalid" for one flake, but it must
 *     never be published either.
 */

import type { FailureOrigin, ProbeError } from './receipt.ts';

export interface ProbeSummary {
  n_total: number;
  n_scored: number;
  completion_rate: number;
  errors: ProbeError[];
  /** Harness+dependency+judge error rate over n_total (sut failures are scored, not errors-only). */
  infra_error_rate: number;
  run_invalid: boolean;
  publishable: boolean;
}

const INFRA_ORIGINS: FailureOrigin[] = ['harness', 'dependency', 'judge'];
const INVALID_THRESHOLD = 0.10;
const MIN_N_FOR_THRESHOLD = 10;

export class ProbeAccounting {
  private scores = new Map<string, number>();
  private probeErrors: ProbeError[] = [];
  private expected: number;

  /** `expected` = planned probe count (n_total). Probes never attempted still count in completion rate. */
  constructor(expected: number) {
    this.expected = expected;
  }

  /** Record a successfully scored probe. */
  score(probeId: string, value: number): void {
    this.scores.set(probeId, value);
  }

  /**
   * Record a failure. SUT failures are ALSO scored as 0 (miss) so they stay
   * in the primary-metric denominator; infra-class failures are excluded.
   */
  error(probeId: string, origin: FailureOrigin, message: string): void {
    this.probeErrors.push({ probe_id: probeId, origin, message: truncate(message) });
    if (origin === 'sut') this.scores.set(probeId, 0);
  }

  /** Values that participate in primary metrics (includes sut-failure zeros). */
  scoredValues(): number[] {
    return [...this.scores.values()];
  }

  /** Mean over scored probes. NaN when nothing scored — never a fake 0. */
  mean(): number {
    const v = this.scoredValues();
    if (v.length === 0) return NaN;
    return v.reduce((a, b) => a + b, 0) / v.length;
  }

  summary(): ProbeSummary {
    const nTotal = this.expected;
    const nScored = this.scores.size;
    const infraErrors = this.probeErrors.filter(e => INFRA_ORIGINS.includes(e.origin));
    const infraRate = nTotal > 0 ? infraErrors.length / nTotal : 0;
    const runInvalid = nTotal >= MIN_N_FOR_THRESHOLD && infraRate > INVALID_THRESHOLD;
    const publishable = !runInvalid && !(nTotal < MIN_N_FOR_THRESHOLD && infraErrors.length > 0);
    return {
      n_total: nTotal,
      n_scored: nScored,
      completion_rate: nTotal > 0 ? nScored / nTotal : 0,
      errors: [...this.probeErrors],
      infra_error_rate: infraRate,
      run_invalid: runInvalid,
      publishable,
    };
  }
}

function truncate(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

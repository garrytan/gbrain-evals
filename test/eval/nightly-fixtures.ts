/** Shared fixtures for the nightly tests: one outcome row with defaults. */
import { OUTCOME_SCHEMA, type Outcome } from '../../eval/runner/nightly/outcome.ts';

export const row = (o: Partial<Outcome> = {}): Outcome => ({
  schema: OUTCOME_SCHEMA, night: '2026-11-09', suite: 'suite-a', suite_digest: 'digest-a', item: 'item-1', role: 'headroom', reader: 'gpt-6.1-sol', ref: 'master',
  sha: 'a'.repeat(40), trial: 1, pass: false, score: 0, cost_usd: null, stop: 'submitted', tool_errors: [], evidence: {}, harness: null, ...o,
});

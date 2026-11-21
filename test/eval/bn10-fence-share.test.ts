/** Keyless: fence summaries keep only the last delivery for each policy and question. */
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureFences } from '../../eval/runner/bn10/fence-share.ts';
import { sha256 } from '../../eval/runner/memory-qa/records.ts';
import { generateBN10DryRunCells } from '../../eval/runner/q1/cells/bn10.ts';
import { policyKey } from '../../eval/runner/q1/cells/definitions.ts';

test('the pilot aggregates all three arms separately without double counting retries', () => {
  const def = generateBN10DryRunCells()[0]!;
  const root = mkdtempSync(join(tmpdir(), 'bn10-fence-fixture-'));
  try {
    const run = join(root, 'runs', def.id), logs = join(run, 'r', 'fixture');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(run, 'realizations.ndjson'), JSON.stringify({ conversation: 'fixture-conv', realization_id: 'fixture', attempt: 0, event: 'ingested' }) + '\n');
    const row = (arm: number, id: string, tokens: number, outcome = 'scored', recorded = true) => {
      const a = def.arms[arm]!, policy = policyKey(a);
      const overlay = sha256(JSON.stringify(Object.fromEntries(Object.entries(a.retrieval!.overlay).sort())));
      return { key: `${id}|${policy}`, policy, question_id: id, outcome, applied_settings: { overlay_sha256: overlay,
        ...(recorded ? { fence: { delivered_rows: 4, fenced_rows: 2, unmatched_quoted_rows: arm === 2 ? 1 : 0, fence_tokens: tokens, budget_tokens: 5500, budget_share: tokens / 5500 } } : {}) } };
    };
    writeFileSync(join(logs, 'retrievals.ndjson'), [
      row(0, 'fixture-secret-01', 999), row(0, 'fixture-secret-01', 20), row(0, 'fixture-secret-02', 40, 'ingest_degraded'),
      row(1, 'fixture-secret-01', 22, 'scored', false), row(1, 'fixture-secret-02', 0, 'retrieval_error'), row(2, 'fixture-secret-01', 70),
    ].map(r => JSON.stringify(r) + '\n').join(''));
    const summary = measureFences(def, [root]);
    expect(summary.p).toMatchObject({ measured_contexts: 2, overlay_mismatches: 0, mean_delivered_rows: 4, mean_fenced_rows: 2, mean_fence_tokens: 30, share_of_reference_budget: 30 / 5500 });
    expect(summary.a0).toMatchObject({ delivered_contexts: 1, missing_measurements: 1, mean_fence_tokens: null });
    expect(summary.whole).toMatchObject({ measured_contexts: 1, mean_fence_tokens: 70, unmatched_quoted_rows: 1 });
    expect(summary.p.unmatched_quoted_rows).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('fixture-secret-');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

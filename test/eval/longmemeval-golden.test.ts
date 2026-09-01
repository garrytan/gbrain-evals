/**
 * LongMemEval golden regression — the 2am test. Keyless, $0, no network.
 *
 * Re-derives the published erratum-resolution summary
 * (docs/benchmarks/2026-05-07-longmemeval-s/rescore-may-2026-08-31.json)
 * from the committed raw per-question stream
 * (docs/benchmarks/2026-05-07-longmemeval-s/rescore-may-copy.ndjson)
 * through the SAME code path the publication used: dedupeRows +
 * aggregateRows → summarizeAdapterRows (one metric implementation, zero
 * drift). Every published number for ALL FOUR adapters must match
 * digit-for-digit — recall_all@k, recall_any@k, ndcg_any@k, abs_noise@k,
 * totals/error counts, every recall_by_type bucket, and the latency stats.
 *
 * If summarizeAdapterRows changes semantics, or the committed NDJSON or the
 * published JSON is edited, this fails with the exact field. New ADDITIVE
 * summary fields (e.g. diagnostics from later runner work) do not fail this
 * test: comparison iterates the PUBLISHED object's keys.
 *
 * The stream is legacy-format (no per-row top_k/dataset stamps), so k=5 and
 * dataset 's' are passed explicitly — same as the published aggregation
 * (see the rescore JSON's opts block).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { dedupeRows, aggregateRows } from '../../eval/runner/longmemeval-aggregate.ts';
import type { RunSummary } from '../../eval/runner/longmemeval.ts';

const DIR = join(import.meta.dir, '../../docs/benchmarks/2026-05-07-longmemeval-s');
const NDJSON_PATH = join(DIR, 'rescore-may-copy.ndjson');
const PUBLISHED_PATH = join(DIR, 'rescore-may-2026-08-31.json');

/** Transparent .gz read so a future gzip of the fixture keeps this test keyless-green. */
function readMaybeGz(path: string): string {
  const buf = readFileSync(path);
  return path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

const published = JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8')) as {
  opts: { datasetName: string; topK: number };
  summaries: RunSummary[];
};

const { rows, dupes, parseErrors } = dedupeRows(readMaybeGz(NDJSON_PATH));
const derived = aggregateRows(rows, published.opts.topK, published.opts.datasetName);

describe('longmemeval golden regression (committed May NDJSON)', () => {
  test('published aggregation params are the _s split at k=5', () => {
    expect(published.opts.topK).toBe(5);
    expect(published.opts.datasetName).toBe('s');
  });

  test('stream shape: 2,000 unique rows, 696 resume dupes, zero parse errors', () => {
    expect(rows.length).toBe(2000);
    expect(dupes).toBe(696);
    expect(parseErrors).toBe(0);
  });

  test('all four published adapters derive, no extras', () => {
    expect(derived.map(s => s.adapter).sort()).toEqual(
      published.summaries.map(s => s.adapter).sort(),
    );
    expect(published.summaries.map(s => s.adapter).sort()).toEqual(
      ['gbrain-hybrid', 'gbrain-hybrid+expansion', 'gbrain-keyword', 'gbrain-vector'],
    );
  });

  // Anti-drift anchors: the exact headline values, hardcoded. If EITHER the
  // committed NDJSON or the published JSON is swapped consistently, the
  // key-by-key comparison below would still pass — these literals wouldn't.
  test('headline anchors match the published erratum resolution', () => {
    const byAdapter = new Map(published.summaries.map(s => [s.adapter, s]));
    expect(byAdapter.get('gbrain-keyword')!.recall_all_at_k).toBe(0.10638297872340426);
    expect(byAdapter.get('gbrain-vector')!.recall_all_at_k).toBe(0.7936170212765957);
    expect(byAdapter.get('gbrain-hybrid')!.recall_all_at_k).toBe(0.8340425531914893);
    expect(byAdapter.get('gbrain-hybrid+expansion')!.recall_all_at_k).toBe(0.8425531914893617);
    expect(byAdapter.get('gbrain-hybrid')!.recall_any_at_k).toBe(0.9765957446808511);
  });

  for (const pub of published.summaries) {
    describe(pub.adapter, () => {
      const got = derived.find(s => s.adapter === pub.adapter)!;

      test('summary metrics match digit-for-digit', () => {
        expect(got).toBeDefined();
        // Every key the PUBLISHED summary carries must re-derive exactly —
        // recall_all_at_k, recall_any_at_k, ndcg_any_at_k, abs_noise_at_k,
        // total/n_rows/n_abs/error counts, latency stats. recall_by_type is
        // asserted per-bucket below for a sharper failure message.
        for (const key of Object.keys(pub) as Array<keyof RunSummary>) {
          if (key === 'recall_by_type') continue;
          expect({ field: key, value: got[key] }).toEqual({ field: key, value: pub[key] });
        }
      });

      test('every recall_by_type bucket matches digit-for-digit', () => {
        const pubTypes = Object.keys(pub.recall_by_type).sort();
        expect(Object.keys(got.recall_by_type).sort()).toEqual(pubTypes);
        expect(pubTypes).toEqual([
          'knowledge-update',
          'multi-session',
          'single-session-assistant',
          'single-session-preference',
          'single-session-user',
          'temporal-reasoning',
        ]);
        for (const qtype of pubTypes) {
          const pubBucket = pub.recall_by_type[qtype] as unknown as Record<string, unknown>;
          const gotBucket = got.recall_by_type[qtype] as unknown as Record<string, unknown>;
          // Published keys only: later runner work may ADD diagnostic fields
          // to TypeBucket (e.g. session_shortfall_rate); every number the
          // publication carries must still re-derive exactly.
          for (const k of Object.keys(pubBucket)) {
            expect({ qtype, field: k, value: gotBucket[k] }).toEqual({
              qtype,
              field: k,
              value: pubBucket[k],
            });
          }
        }
      });
    });
  }
});

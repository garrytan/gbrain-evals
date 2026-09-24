import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsQuestion, scoreQuestion } from '../../eval/runner/longmemeval.ts';

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/data/longmemeval-m-pilot-selection.json'), 'utf8'));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('frozen cleaned LongMemEval-M pilot selection', () => {
  test('uses the pinned upstream blob and 28 unique deterministic IDs across seven buckets', () => {
    expect(manifest.dataset_sha256).toBe('9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f');
    expect(manifest.dataset_bytes).toBe(2737100077);
    expect(manifest.selection_seed).toBe('gbrain-tmem-lme-m-v1');
    expect(manifest.total_questions).toBe(500);
    const buckets = Object.entries(manifest.selected) as Array<[string, string[]]>;
    expect(buckets).toHaveLength(7);
    expect(Object.values(manifest.bucket_counts).reduce((sum: number, count) => sum + Number(count), 0)).toBe(500);
    for (const [bucket, ids] of buckets) {
      expect(ids).toHaveLength(4);
      expect(manifest.bucket_counts[bucket]).toBeGreaterThanOrEqual(4);
      expect(ids.map(id => hash(`${manifest.selection_seed}\0${id}`))).toEqual(
        ids.map(id => hash(`${manifest.selection_seed}\0${id}`)).sort(),
      );
      for (const id of ids) expect(isAbsQuestion(id)).toBe(bucket === 'abstention');
    }
    expect(new Set(manifest.selected_ids).size).toBe(28);
    expect(manifest.selected_ids).toEqual(buckets.flatMap(([, ids]) => ids));
  });

  test('keeps full source occurrences separate from native session-level scoring labels', () => {
    const details = Object.values(manifest.selected_source_details) as Array<{ source_sha256: string; source_bytes: number; sessions: number; repeated_id_occurrences: number }>;
    expect(details).toHaveLength(28);
    expect(details.reduce((sum, item) => sum + item.sessions, 0)).toBe(13328);
    expect(details.reduce((sum, item) => sum + item.source_bytes, 0)).toBe(142216395);
    expect(details.reduce((sum, item) => sum + item.repeated_id_occurrences, 0)).toBe(60);
    expect(manifest.histories_with_repeated_gold_session_ids).toBe(0);
    expect(details.every(item => /^[a-f0-9]{64}$/.test(item.source_sha256))).toBe(true);
    expect(details.every(item => Object.keys(item).every(key => !['question', 'answer', 'question_type', 'required_sessions', 'repeated_gold_ids'].includes(key)))).toBe(true);
    expect(scoreQuestion(['first', 'other', 'first'], ['first', 'second'], 5).recall_all).toBe(0);
    expect(scoreQuestion(['first', 'second'], ['first', 'second'], 5).recall_all).toBe(1);
  });
});

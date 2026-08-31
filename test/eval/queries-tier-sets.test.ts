/**
 * Tier 5 / 5.5 query set + validator regression suite (hermetic, no keys).
 *
 * Pins the audit fixes:
 *   - adapters-queries-05: q5-0004 now carries real gold (verified founder
 *     slugs + expected_answer) instead of relevant: [] with no answer — the
 *     shape that structurally could never score.
 *   - adapters-queries-06: getTier5FuzzyQueries / getTier5_5SyntheticQueries
 *     return DEEP copies; mutating a returned query's gold.relevant (or
 *     acceptable_variants / known_failure_modes) can no longer poison the
 *     canonical module set for later callers.
 *   - adapters-queries-09: the validator enforces gold shape for all 8
 *     expected_output_types (the full matrix lives in
 *     eval/runner/queries/validator.test.ts; this file pins the CI-critical
 *     answer-string case that let q5-0004 ship).
 *   - Corpus integrity: every gold slug in both shipped tiers resolves to a
 *     real page in eval/data/world-v1/ (they now actually execute against
 *     that corpus via multi-adapter.ts, audit adapters-queries-07).
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  getTier5FuzzyQueries,
  getTier5_5SyntheticQueries,
  getAllTierQueries,
  validateAll,
  validateQuery,
} from '../../eval/runner/queries/index.ts';

const WORLD_DIR = join(import.meta.dir, '../../eval/data/world-v1');

function worldSlugs(): Set<string> {
  const files = readdirSync(WORLD_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  return new Set(files.map(f => JSON.parse(readFileSync(join(WORLD_DIR, f), 'utf8')).slug as string));
}

describe('shipped tier sets pass the extended validator', () => {
  test('validateAll is clean over all 80 built-in queries', () => {
    const r = validateAll();
    expect(r.count).toBe(80);
    expect(r.ok).toBe(true);
  });

  test('the extended validator can FAIL: answer-string with empty gold (old q5-0004 shape)', () => {
    const r = validateQuery({
      id: 'q5-0004-old-shape',
      tier: 'fuzzy',
      text: 'Summarize what we know about founders who raised Series A in 2024.',
      expected_output_type: 'answer-string',
      gold: { relevant: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.field === 'gold.expected_answer')).toBe(true);
  });
});

describe('q5-0004 has scoreable gold (audit adapters-queries-05)', () => {
  test('carries non-empty relevant plus expected_answer', () => {
    const q = getTier5FuzzyQueries().find(q => q.id === 'q5-0004');
    expect(q).toBeDefined();
    expect(q!.gold.relevant).toEqual([
      'people/adam-lee-19',
      'people/carol-wilson-28',
      'people/nina-rodriguez-18',
    ]);
    expect(typeof q!.gold.expected_answer).toBe('string');
    expect((q!.gold.expected_answer as string).length).toBeGreaterThan(0);
  });

  test('its gold slugs are verified founder pages with a 2024 Series A on their timeline', () => {
    const q = getTier5FuzzyQueries().find(q => q.id === 'q5-0004')!;
    for (const slug of q.gold.relevant!) {
      const file = join(WORLD_DIR, `${slug.replace('/', '__')}.json`);
      const page = JSON.parse(readFileSync(file, 'utf8'));
      expect(page._facts.role).toBe('founder');
      const timeline = Array.isArray(page.timeline) ? page.timeline.join('\n') : String(page.timeline);
      expect(/2024-\d{2}-\d{2}[^\n]*Series A/i.test(timeline)).toBe(true);
    }
  });
});

describe('gold slugs resolve to real world-v1 pages', () => {
  test('every gold.relevant slug across tier 5 + 5.5 exists in the corpus', () => {
    const slugs = worldSlugs();
    const missing: string[] = [];
    for (const q of getAllTierQueries()) {
      for (const s of q.gold.relevant ?? []) {
        if (!slugs.has(s)) missing.push(`${q.id}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('getters return DEEP copies (audit adapters-queries-06)', () => {
  test('mutating gold.relevant on a returned tier-5 query does not leak into later calls', () => {
    const first = getTier5FuzzyQueries();
    const q1 = first.find(q => q.id === 'q5-0001')!;
    const before = [...(q1.gold.relevant ?? [])];
    q1.gold.relevant!.push('people/injected-mutation');
    q1.known_failure_modes?.push('injected');
    q1.tags?.push('injected');

    const second = getTier5FuzzyQueries();
    const q2 = second.find(q => q.id === 'q5-0001')!;
    expect(q2.gold.relevant).toEqual(before);
    expect(q2.known_failure_modes ?? []).not.toContain('injected');
    expect(q2.tags ?? []).not.toContain('injected');
  });

  test('mutating gold.relevant on a returned tier-5.5 query does not leak into later calls', () => {
    const first = getTier5_5SyntheticQueries();
    const q1 = first.find(q => q.id === 'q55-0001')!;
    const before = [...(q1.gold.relevant ?? [])];
    q1.gold.relevant!.splice(0, q1.gold.relevant!.length);

    const second = getTier5_5SyntheticQueries();
    const q2 = second.find(q => q.id === 'q55-0001')!;
    expect(q2.gold.relevant).toEqual(before);
  });

  test('acceptable_variants is not shared by reference (q5-0004)', () => {
    const first = getTier5FuzzyQueries().find(q => q.id === 'q5-0004')!;
    first.acceptable_variants!.push('injected variant');
    const second = getTier5FuzzyQueries().find(q => q.id === 'q5-0004')!;
    expect(second.acceptable_variants).not.toContain('injected variant');
  });
});

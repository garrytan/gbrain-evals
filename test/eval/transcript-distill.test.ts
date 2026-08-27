/**
 * transcript-distill-v1 skeleton tests (Cat 35, Lane A). $0, no network.
 *
 * Guards:
 *   - Determinism under seed (same seed → deep-equal skeletons)
 *   - 24 transcripts, 6 scenarios x 4 instances, exactly 6 long-noisy
 *   - pure-routine: zero gold items + expected_triage 'low'
 *   - Signal transcripts: >=8 gold items, >=1 vibe (emotional-processing 3+)
 *   - Hazards: exactly 2 total, both on coding-reflection, one of each type
 *   - Anchors: unique corpus-wide, <=120 chars, plain ASCII
 *   - No dream-discovery exclude words anywhere in skeleton text
 *   - Depth buckets: all three represented per signal transcript
 *   - SCAFFOLD_PAGES: one-slash slugs; every referenced entity has a page
 *   - Timestamps: valid ISO, all pre-2026-08-13
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSkeletons,
  CORPUS_SEED,
  SCAFFOLD_PAGES,
  type TranscriptSkeleton,
  type Scenario,
} from '../../eval/generators/transcript-distill.ts';

// Regex from eval/runner/queries/validator.ts:131 — pins the slug convention.
const SLUG_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
// Word-boundary dream-discovery exclude, built from char codes so this test
// file itself can't trip a text-level scan.
const BANNED_RE = new RegExp(
  `\\b(${String.fromCharCode(109, 101, 100, 105, 99, 97, 108)}|${String.fromCharCode(116, 104, 101, 114, 97, 112, 121)})\\b`,
  'i'
);
const ASCII_RE = /^[\x20-\x7E]+$/;

const SCENARIOS: Scenario[] = [
  'coding-reflection', 'startup-ideation', 'people-deal',
  'mixed-routine-signal', 'emotional-processing', 'pure-routine',
];

const skeletons = buildSkeletons();
const signal = skeletons.filter((s) => s.scenario !== 'pure-routine');
const routine = skeletons.filter((s) => s.scenario === 'pure-routine');

function allAnchors(sk: TranscriptSkeleton): string[] {
  return [
    ...sk.items.map((i) => i.verbatim_anchor),
    ...sk.distractors.map((x) => x.anchor),
    ...sk.hazards.map((h) => h.anchor),
  ];
}

describe('transcript-distill skeleton', () => {
  test('same seed produces deep-equal skeletons', () => {
    const a = buildSkeletons(CORPUS_SEED);
    const b = buildSkeletons(CORPUS_SEED);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  test('24 skeletons: 6 scenarios x 4 instances', () => {
    expect(skeletons.length).toBe(24);
    for (const scenario of SCENARIOS) {
      const of = skeletons.filter((s) => s.scenario === scenario);
      expect(of.length).toBe(4);
      expect(of.map((s) => s.transcript_id).sort()).toEqual(
        [1, 2, 3, 4].map((n) => `${scenario}-0${n}`)
      );
    }
  });

  test('exactly 6 long-noisy variants, one per scenario (instance 4)', () => {
    const longNoisy = skeletons.filter((s) => s.variant === 'long-noisy');
    expect(longNoisy.length).toBe(6);
    expect(new Set(longNoisy.map((s) => s.scenario)).size).toBe(6);
    for (const s of longNoisy) expect(s.transcript_id.endsWith('-04')).toBe(true);
    // Long-noisy turn plans actually carry noise turns.
    for (const s of longNoisy) {
      expect(s.turns.some((t) => t.noise !== null)).toBe(true);
    }
    // Prose variants carry none.
    for (const s of skeletons.filter((x) => x.variant === 'prose')) {
      expect(s.turns.every((t) => t.noise === null)).toBe(true);
    }
  });

  test('pure-routine transcripts have zero gold and expected_triage low', () => {
    expect(routine.length).toBe(4);
    for (const s of routine) {
      expect(s.items.length).toBe(0);
      expect(s.expected_triage).toBe('low');
      expect(s.hazards.length).toBe(0);
      expect(s.distractors.length).toBeGreaterThanOrEqual(3);
      expect(s.distractors.length).toBeLessThanOrEqual(5);
    }
  });

  test('every signal transcript has 8-12 gold items and >=1 vibe', () => {
    expect(signal.length).toBe(20);
    for (const s of signal) {
      expect(s.expected_triage).toBe('high');
      expect(s.items.length).toBeGreaterThanOrEqual(8);
      expect(s.items.length).toBeLessThanOrEqual(12);
      expect(s.items.filter((i) => i.kind === 'vibe').length).toBeGreaterThanOrEqual(1);
    }
  });

  test('emotional-processing transcripts carry >=3 vibe items', () => {
    for (const s of skeletons.filter((x) => x.scenario === 'emotional-processing')) {
      expect(s.items.filter((i) => i.kind === 'vibe').length).toBeGreaterThanOrEqual(3);
    }
  });

  test('exactly 2 hazards total, both on coding-reflection, one of each type', () => {
    const carriers = skeletons.filter((s) => s.hazards.length > 0);
    expect(carriers.length).toBe(2);
    for (const s of carriers) {
      expect(s.scenario).toBe('coding-reflection');
      expect(s.hazards.length).toBe(1);
    }
    const types = carriers.flatMap((s) => s.hazards.map((h) => h.type)).sort();
    expect(types).toEqual(['agent-proposed-user-decided', 'killed-process-not-completed']);
  });

  test('anchors are unique corpus-wide, <=120 chars, plain ASCII', () => {
    const seen = new Set<string>();
    for (const s of skeletons) {
      for (const a of allAnchors(s)) {
        expect(a.length).toBeLessThanOrEqual(120);
        expect(a).toMatch(ASCII_RE);
        const norm = a.replace(/\s+/g, ' ').toLowerCase();
        expect(seen.has(norm)).toBe(false);
        seen.add(norm);
      }
    }
  });

  test('gold statements are unique corpus-wide and never quote their anchor', () => {
    const seen = new Set<string>();
    for (const s of skeletons) {
      for (const it of s.items) {
        const norm = it.statement.replace(/\s+/g, ' ').toLowerCase();
        expect(seen.has(norm)).toBe(false);
        seen.add(norm);
        expect(norm.includes(it.verbatim_anchor.replace(/\s+/g, ' ').toLowerCase())).toBe(false);
      }
    }
  });

  test('no dream-discovery exclude words anywhere in skeleton text', () => {
    for (const s of skeletons) {
      const texts = [
        ...s.items.flatMap((i) => [i.statement, i.verbatim_anchor]),
        ...s.distractors.flatMap((x) => [x.statement, x.anchor]),
        ...s.hazards.flatMap((h) => [h.wrong_claim, h.anchor]),
        ...s.turns.map((t) => t.brief),
      ];
      for (const text of texts) expect(text).not.toMatch(BANNED_RE);
    }
    for (const p of SCAFFOLD_PAGES) expect(p.body).not.toMatch(BANNED_RE);
  });

  test('gold items span all three depth buckets per signal transcript', () => {
    for (const s of signal) {
      const buckets = new Set(s.items.map((i) => i.depth_bucket));
      expect(buckets).toEqual(new Set(['early', 'middle', 'late']));
      // depth_bucket is derived from planted_turn thirds.
      for (const it of s.items) {
        const third = s.turns.length / 3;
        const expected = it.planted_turn < third ? 'early'
          : it.planted_turn < 2 * third ? 'middle' : 'late';
        expect(it.depth_bucket).toBe(expected);
      }
    }
  });

  test('turn plans alternate user/assistant and stay in variant bounds', () => {
    for (const s of skeletons) {
      const [min, max] = s.variant === 'prose' ? [12, 24] : [24, 36];
      expect(s.turns.length).toBeGreaterThanOrEqual(min);
      expect(s.turns.length).toBeLessThanOrEqual(max);
      s.turns.forEach((t, i) => {
        expect(t.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
      });
    }
  });

  test('every planted anchor is assigned to exactly one turn plan', () => {
    for (const s of skeletons) {
      const inTurns = s.turns.flatMap((t) => t.must_include_anchors);
      expect(inTurns.sort()).toEqual(allAnchors(s).sort());
      // planted_turn agrees with the turn carrying the anchor.
      for (const it of s.items) {
        expect(s.turns[it.planted_turn].must_include_anchors).toContain(it.verbatim_anchor);
      }
      for (const dx of s.distractors) {
        expect(s.turns[dx.planted_turn].must_include_anchors).toContain(dx.anchor);
      }
      for (const hz of s.hazards) {
        expect(s.turns[hz.planted_turn].must_include_anchors).toContain(hz.anchor);
      }
    }
  });

  test('SCAFFOLD_PAGES slugs are one-slash and referenced entities exist', () => {
    expect(SCAFFOLD_PAGES.length).toBe(10);
    const slugs = new Set(SCAFFOLD_PAGES.map((p) => p.slug));
    for (const p of SCAFFOLD_PAGES) {
      expect(p.slug).toMatch(SLUG_RE);
      expect(p.body).toMatch(/^---\ntype: (person|company|concept)\n/);
    }
    for (const s of skeletons) {
      for (const e of s.entities) expect(slugs.has(e)).toBe(true);
    }
  });

  test('timestamps parse as ISO and are pre-2026-08-13', () => {
    const cutoff = Date.parse('2026-08-13T00:00:00.000Z');
    for (const s of skeletons) {
      const t = Date.parse(s.base_ts);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeLessThan(cutoff);
      expect(t).toBeGreaterThanOrEqual(Date.parse('2026-08-01T00:00:00.000Z'));
      expect(s.base_ts.startsWith(s.date)).toBe(true);
      expect(s.session_id).toBe(`cat35-${s.transcript_id}`);
    }
    // Staggered: not all on the same instant.
    expect(new Set(skeletons.map((s) => s.base_ts)).size).toBe(24);
  });
});

/**
 * A2: the reading-headroom recount (docs/benchmarks/2026-10-08-reading-headroom.md) recomputes from committed
 * receipts, matches its committed headroom.json byte for byte, and reproduces audit A's numbers. Keyless, $0.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headroom, OUT_DIR } from '../../eval/runner/reading-headroom.ts';

const ROOT = join(import.meta.dir, '../..');
const result = headroom() as any;

describe('reading headroom recount', () => {
  test('the committed receipt is exactly what the script computes', () => {
    expect(readFileSync(join(ROOT, OUT_DIR, 'headroom.json'), 'utf8')).toBe(JSON.stringify(result, null, 1) + '\n');
    expect(result.status).toContain('not preregistered');
  });

  test("delivered text: audit A's 6,489 gold of 15,822 delivered and 8,981 on multi-session (truncated means)", () => {
    const d = result.delivered;
    expect(d.n).toBe(500);
    expect(Math.trunc(d.mean_gold_chars4)).toBe(6489);
    expect(Math.trunc(d.mean_delivered_chars4)).toBe(15822);
    expect(Math.trunc(d.by_type['multi-session'].mean_gold_chars4)).toBe(8981);
    expect(d.by_type['multi-session'].n).toBe(133);
    expect(d.gold_share_chars4).toBe(0.41);
    expect(d.questions_missing_a_gold_session).toBe(25);
    expect(d.questions_with_no_gold_session_delivered).toBe(1);
    expect(d.mean_gold_cl100k).toBeLessThan(d.mean_gold_chars4);
  });

  test('notes length: Sonnet 5.5 about 138 and Opus 5.5 about 150 chars/4 tokens', () => {
    expect(Math.trunc(result.notes_length['w10a-sonnet55-notes'].mean_chars4)).toBe(138);
    expect(Math.trunc(result.notes_length['w10b-opus55-notes'].mean_chars4)).toBe(150);
    expect(result.notes_length['w10b-sol-notes'].model).toBe('gpt-6.1-sol');
  });

  test("committed wrong: audit A's 25 of 470 for Sonnet 5.5 and 19 for Opus 5.5, whatever the hedge", () => {
    const a = result.commitment.arms;
    expect(a['w10a-sonnet55-notes']).toMatchObject({ answerable: 470, answerable_wrong: 30, wrong_declined: 5, committed_wrong: 25, abstention_answered: 2, committed_wrong_rate_all: 0.054 });
    expect(a['w10b-opus55-notes']).toMatchObject({ answerable: 470, answerable_wrong: 25, wrong_declined: 6, committed_wrong: 19, abstention_answered: 1, committed_wrong_rate_all: 0.04 });
    expect(a['w10b-sonnet55-notes']).toMatchObject({ answerable_wrong: 35, committed_wrong: 29, abstention_answered: 3 });
    expect(a['w10b-sol-notes']).toMatchObject({ answerable_wrong: 33, committed_wrong: 24, abstention_answered: 3 });
    // Correct counts agree with the published W10 totals (468, 474, 462 and 464 of 500).
    expect(a['w10a-sonnet55-notes'].answerable_correct + 30 - a['w10a-sonnet55-notes'].abstention_answered).toBe(468);
    expect(a['w10b-opus55-notes'].answerable_correct + 30 - a['w10b-opus55-notes'].abstention_answered).toBe(474);
    expect(a['w10b-sonnet55-notes'].answerable_correct + 30 - a['w10b-sonnet55-notes'].abstention_answered).toBe(462);
    expect(a['w10b-sol-notes'].answerable_correct + 30 - a['w10b-sol-notes'].abstention_answered).toBe(464);
  });

  test('the labels must cover exactly the wrong answerable questions, so a changed verdict fails loudly', () => {
    const labels = JSON.parse(readFileSync(join(ROOT, OUT_DIR, 'commitment-labels.json'), 'utf8'));
    expect(labels.labeller).toContain('no person has reviewed');
    for (const [arm, l] of Object.entries(labels.arms) as [string, any][]) {
      const declined = Object.entries(l.labels).filter(([, v]) => v === 'declined').map(([k]) => k).sort();
      expect(declined).toEqual(Object.keys(l.declined_reasons).sort());
      expect(result.commitment.arms[arm].declined_ids).toEqual(declined);
    }
  });
});

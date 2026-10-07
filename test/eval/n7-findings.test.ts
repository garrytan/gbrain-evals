import { describe, expect, test } from 'bun:test';
import { n7Findings } from '../../eval/runner/n7-open-loops-email.ts';

const SHA = 'c5fb0201d1960a0a5a81c35d77718311b03154b7';
const base = { detection: null, semantic: null, age_from_detection: null } as Record<string, unknown>;
const ids = (r: Record<string, unknown>) => n7Findings(r as never, SHA).map(f => f.id);

describe('n7Findings follows the measurement', () => {
  test('N7-2 only when an acknowledgement closed a reply-owed loop', () => {
    expect(ids({ ...base, store: { ack_closed: 0, ack_rounds: 4 }, ranking: null })).not.toContain('N7-2');
    expect(ids({ ...base, store: { ack_closed: 2, ack_rounds: 4 }, ranking: null })).toContain('N7-2');
  });

  test('N7-5 only when the order moves with the clock and as_of does not pin it', () => {
    expect(ids({ ...base, store: null, ranking: { order_changes_with_clock_alone: true, as_of_pins_order: true } })).not.toContain('N7-5');
    expect(ids({ ...base, store: null, ranking: { order_changes_with_clock_alone: true, as_of_pins_order: false } })).toContain('N7-5');
    expect(ids({ ...base, store: null, ranking: { order_changes_with_clock_alone: false } })).not.toContain('N7-5');
  });
});

/**
 * N7 open-loops-email: generator determinism, the documented-rule oracle on
 * hand-built threads, the scorer and its preregistered gate, a deliberately
 * broken detector, the scorer mutation suite, and the raw Gmail rendering
 * through gbrain's own parser.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { registryEntry } from '../../eval/registry.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import {
  EXCLUDED_CLASSES, ME, MY_ADDRESSES, N7_DEFAULT_SEED, N7_NOW_ISO, generateN7World, mechanicsOracle, n7RulesFor, type LedgerMessage, type LedgerThread,
} from '../../eval/generators/n7-gmail-loops-gen.ts';
import {
  asksQuestion, combine, n7Verdict, rawGmailThread, redactionLeaks, scoreDetection, scoreStore,
  type DetectorAnswer, type ScoredThread, type StepResult, type StoreMetrics,
} from '../../eval/runner/n7-open-loops-email.ts';

const m = (o: Partial<LedgerMessage> & { age_hours: number }): LedgerMessage => ({
  id: 'x', from: 'Bob <bob@example.org>', from_address: 'bob@example.org', sent_by_me: false, to: [ME], cc: [], subject: 'Deck', kind: 'human', own_text: 'Can you send the deck?', quoted: '', asks: true, ...o,
});
const mine = (o: Partial<LedgerMessage> & { age_hours: number }) => m({ from: `Me <${ME}>`, from_address: ME, sent_by_me: true, to: ['bob@example.org'], ...o });

describe('N7 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateN7World().fingerprint).toBe(generateN7World({ seed: N7_DEFAULT_SEED }).fingerprint);
    expect(generateN7World({ seed: 99 }).fingerprint).not.toBe(generateN7World().fingerprint);
  });

  test('every class is present, thread ids are unique, no message is in the future, addresses are placeholders', () => {
    const w = generateN7World();
    expect(new Set(w.ledger.threads.map(t => t.id)).size).toBe(w.ledger.threads.length);
    for (const t of w.ledger.threads) for (const msg of t.messages) {
      expect(msg.age_hours).toBeGreaterThan(0);
      for (const a of [msg.from_address, ...msg.to, ...msg.cc]) expect(a.toLowerCase()).toMatch(/@(example\.(com|org|net)|[a-z-]+-example\.(com|io))$/);
    }
    for (const s of w.ledger.scenarios) for (const step of s.steps) if (step.kind === 'apply') {
      for (const msg of s.thread.messages.slice(0, step.messages)) expect(msg.age_hours - step.now_offset_hours).toBeGreaterThan(0);
    }
  });
});

describe('N7 documented-rule oracle', () => {
  test('inbound To me past 24 hours opens; inside the window, CC-only, list and noise do not', () => {
    expect(mechanicsOracle([m({ age_hours: 30 })]).open).toEqual({ loop_type: 'unanswered_inbound', counterparty: 'bob@example.org' });
    expect(mechanicsOracle([m({ age_hours: 10 })]).open).toBeNull();
    expect(mechanicsOracle([m({ age_hours: 30, to: ['x@example.org'], cc: [ME] })]).open).toBeNull();
    expect(mechanicsOracle([m({ age_hours: 30, kind: 'list' })]).open).toBeNull();
    expect(mechanicsOracle([m({ age_hours: 30, kind: 'noise' })]).open).toBeNull();
  });

  test('a nudge does not restart the clock; a reply (even "Thanks!") flips the turn', () => {
    expect(mechanicsOracle([m({ age_hours: 40 }), m({ age_hours: 5, own_text: 'Bump?' })]).open?.loop_type).toBe('unanswered_inbound');
    const thanks = mechanicsOracle([m({ age_hours: 60 }), mine({ age_hours: 30, own_text: 'Thanks!', asks: false })]);
    expect(thanks.open).toBeNull();
    expect(thanks.closes).toBe('unanswered_inbound');
    expect(thanks.closure_case).toBe(true);
  });

  test('ack-is-not-a-reply rules (gbrain 0.60.32.0 and later): my acknowledgement of their question is not an answer', () => {
    expect(n7RulesFor('0.60.30.0')).toBe('reply-closes');
    expect(n7RulesFor('0.60.26.0')).toBe('reply-closes');
    expect(n7RulesFor('0.60.32.0')).toBe('ack-is-not-a-reply');
    expect(n7RulesFor('0.61.0.0')).toBe('ack-is-not-a-reply');
    const rules = 'ack-is-not-a-reply' as const;
    const thanks = mechanicsOracle([m({ age_hours: 60 }), mine({ age_hours: 30, own_text: 'Thanks!', asks: false })], MY_ADDRESSES, rules);
    expect(thanks.open).toEqual({ loop_type: 'unanswered_inbound', counterparty: 'bob@example.org' });
    expect(thanks.closure_case).toBe(false);
    const answered = mechanicsOracle([m({ age_hours: 60 }), mine({ age_hours: 30, own_text: 'Here it is.', asks: false })], MY_ADDRESSES, rules);
    expect(answered.open).toBeNull();
    expect(answered.closure_case).toBe(true);
    const ackOfStatement = mechanicsOracle([m({ age_hours: 60, own_text: 'Here is the deck.', asks: false }), mine({ age_hours: 30, own_text: 'Thanks!', asks: false })], MY_ADDRESSES, rules);
    expect(ackOfStatement.open).toBeNull();
    const w = generateN7World({ rules });
    expect(w.fingerprint).toBe(generateN7World().fingerprint);
    const acks = w.ledger.threads.filter(t => t.klass === 'ack_thanks');
    expect(acks.length).toBe(8);
    for (const t of acks) expect(w.gold.get(t.id)!.open?.loop_type).toBe('unanswered_inbound');
  });

  test('outbound needs a question and 72 hours; a calendar notice neither opens nor closes', () => {
    expect(mechanicsOracle([mine({ age_hours: 80, own_text: 'Any update?' })]).open?.loop_type).toBe('unanswered_outbound');
    expect(mechanicsOracle([mine({ age_hours: 80, own_text: 'FYI', asks: false })]).open).toBeNull();
    expect(mechanicsOracle([mine({ age_hours: 50 })]).open).toBeNull();
    expect(mechanicsOracle([mine({ age_hours: 100 }), m({ age_hours: 3, kind: 'calendar' })]).open?.loop_type).toBe('unanswered_outbound');
  });

  test('asksQuestion ignores question marks inside links', () => {
    expect(asksQuestion('see https://x.example.com/v?id=1 thanks')).toBe(false);
    expect(asksQuestion('Can you look? Thanks')).toBe(true);
  });
});

const PERFECT_STORE: StoreMetrics = {
  calendar_closes: 0, manual_close_reverted: 0, muted_new_loops: 0, closure_rounds: 8, closure_rounds_correct: 8, ack_rounds: 4, ack_closed: 4,
  nudge_rounds: 4, nudge_held_open: 4, reopen_rounds: 4, reopened: 4, turn_flip_rounds: 4, turn_flip_reopened_inbound: 4, presence_failures: [],
};
const world = generateN7World();
const truth = (t: LedgerThread): DetectorAnswer => {
  const g = world.gold.get(t.id)!;
  return { open: g.open, close: g.closes ? [g.closes] : [] };
};
const rowsFor = (answers: readonly DetectorAnswer[]): ScoredThread[] => world.ledger.threads.map((t, i) => ({ id: t.id, klass: t.klass, gold: world.gold.get(t.id)!, answer: answers[i] }));
/** Grade answers exactly as CI does: the runner's metrics checked by the registry's preregistered rules. */
const gate = (answers: readonly DetectorAnswer[]) => {
  const { contracts, quality } = combine(scoreDetection(rowsFor(answers)), PERFECT_STORE, 0);
  const outcome = evaluatePromotion(registryEntry('N7')!.promotion!, { data: { contracts, quality } });
  return { pass: outcome.pass && n7Verdict(contracts, quality).pass, detail: outcome.failures.map(f => f.id).join(',') || 'pass' };
};

describe('N7 scorer', () => {
  test('the documented-rule truth passes the preregistered gate', () => {
    expect(gate(world.ledger.threads.map(truth))).toEqual({ pass: true, detail: 'pass' });
  });

  test('one loop opened on an excluded thread fails the safety contract', () => {
    const answers = world.ledger.threads.map(truth);
    const i = world.ledger.threads.findIndex(t => EXCLUDED_CLASSES.includes(t.klass));
    answers[i] = { open: { loop_type: 'unanswered_inbound', counterparty: 'x@example.org' }, close: [] };
    expect(gate(answers)).toEqual({ pass: false, detail: 'no-loop-from-excluded-mail' });
  });

  test('a deliberately broken detector that ignores grace windows, questions and exclusions fails', () => {
    const broken = world.ledger.threads.map((t): DetectorAnswer => {
      const last = t.messages[t.messages.length - 1];
      return last.sent_by_me
        ? { open: { loop_type: 'unanswered_outbound', counterparty: last.to[0] }, close: ['unanswered_inbound'] }
        : { open: { loop_type: 'unanswered_inbound', counterparty: last.from_address }, close: ['unanswered_outbound'] };
    });
    const g = gate(broken);
    expect(g.pass).toBe(false);
    expect(g.detail).toContain('no-loop-from-excluded-mail');
  });

  test('store steps: a calendar close, a reverted manual close and a muted open each count; a missing precondition is a presence failure', () => {
    const step = (kind: StepResult['kind'], i: number, pass: boolean, expected = 'open x'): StepResult => ({ scenario: `${kind}-0`, kind, step: i, expected, observed: '', pass });
    const s = scoreStore([step('calendar_hold', 1, false), step('manual_close', 2, false), step('mute_sender', 1, false), step('reply_close', 0, false)]);
    expect([s.calendar_closes, s.manual_close_reverted, s.muted_new_loops]).toEqual([1, 1, 1]);
    expect(s.presence_failures).toHaveLength(1);
  });

  test('redaction: quotes, deep links, a text digest or a body are leaks', () => {
    expect(redactionLeaks({ groups: [{ loops: [{ id: 1, summary: 's' }] }] }, ['a body that is long enough to count']).leaks).toBe(0);
    expect(redactionLeaks({ text: 'x', groups: [{ loops: [{ id: 1, quote: 'q', deep_link: 'l' }] }] }, []).leaks).toBe(3);
    expect(redactionLeaks({ groups: [{ loops: [{ id: 1, summary: 'a body that is long enough to count' }] }] }, ['a body that is long enough to count']).leaks).toBe(1);
  });
});

describe('N7 scorer mutation suite', () => {
  test('the gate passes the honest detector and fails every fake', () => {
    const threads = world.ledger.threads;
    const others = threads.map(t => world.gold.get(t.id)!.open?.counterparty).filter((c): c is string => !!c);
    const results = assertScorerRejectsFakeSystems<LedgerThread, DetectorAnswer>({
      category: 'N7',
      probes: threads,
      space: {
        truth,
        empty: () => ({ open: null, close: [] }),
        everything: t => {
          const last = t.messages[t.messages.length - 1];
          return { open: { loop_type: last.sent_by_me ? 'unanswered_outbound' : 'unanswered_inbound', counterparty: world.gold.get(t.id)!.open?.counterparty ?? 'someone@example.org' }, close: [] };
        },
        refusal: () => ({ open: null, close: [] }),
        stale: t => {
          if (t.messages.length < 2) return undefined;
          const g = mechanicsOracle(t.messages.slice(0, -1));
          return { open: g.open, close: g.closes ? [g.closes] : [] };
        },
        wrongSource: t => {
          const g = world.gold.get(t.id)!.open;
          if (!g) return undefined;
          const other = others.find(c => c !== g.counterparty)!;
          return { open: { ...g, counterparty: other }, close: [] };
        },
      },
      score: gate,
    });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});

describe('N7 raw Gmail rendering through gbrain', () => {
  test('GmailClient.getThread parses the rendered JSON: bare lowercase From, quoted reply trimmed, calendar METHOD and List-Unsubscribe kept', async () => {
    const G = join(import.meta.dir, '../../node_modules/gbrain/src/core');
    const { GmailClient } = await import(`${G}/google/google-clients.ts`);
    const nowMs = Date.parse(N7_NOW_ISO);
    const t = {
      id: 'abcdef0123456789',
      messages: [
        m({ id: 'm1', age_hours: 50, from: 'Bob <BOB@Example.org>' }),
        mine({ id: 'm2', age_hours: 40, own_text: 'Done, sent.', quoted: 'On Mon, Sep 28, 2026 at 9:00 AM Bob wrote:\n> Can you send the deck?', asks: false }),
        m({ id: 'm3', age_hours: 30, kind: 'calendar', subject: 'Invitation: sync' }),
        m({ id: 'm4', age_hours: 20, kind: 'list' }),
      ],
    };
    const raw = rawGmailThread(t, nowMs);
    const client = new GmailClient({ getAccessToken: async () => 't', forceRefresh: async () => 't' }, async () => new Response(JSON.stringify(raw)));
    const parsed = await client.getThread(t.id, ME);
    expect(parsed.messages.map((x: { fromAddress: string }) => x.fromAddress)).toEqual(['bob@example.org', ME, 'bob@example.org', 'bob@example.org']);
    expect(parsed.messages[1].bodyText).toBe('Done, sent.');
    expect(parsed.messages[2].calendarMethod).toBe('REQUEST');
    expect(parsed.messages[3].listUnsubscribe).toBe(true);
    expect(parsed.messages[0].internalDateMs).toBe(nowMs - 50 * 3_600_000);
  });
});

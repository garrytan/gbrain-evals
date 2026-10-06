/**
 * Event time on the real datasets (engineering review C6). Every session a
 * shootout system receives carries an ISO event time, either the dataset's own
 * or a disclosed synthetic one, sessions arrive in event-time order, and every
 * question has a query time, and building the sanitizer stays well under 20 seconds even on LongMemEval-S (it once
 * took 28 minutes). The counts are pinned: the datasets are pinned by
 * SHA-256, so a change here means the loader or the date policy changed.
 *
 * Needs the datasets (`bun run eval:decide fetch --benchmark <name>`, free, no key); each benchmark is skipped
 * when its files are missing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATASET_ROOT, filesFor, loadCorpus } from '../../eval/runner/memory-qa/corpus.ts';
import { eventTimeOf, Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const present = (b: string) => filesFor(b).every(f => existsSync(join(DATASET_ROOT, f.path)));

const EXPECTED: Record<string, { conversations: number; sessions: number; dated: number; synthetic: number; questions: number; questionsDated: number }> = {
  locomo: { conversations: 10, sessions: 272, dated: 272, synthetic: 0, questions: 1986, questionsDated: 0 },
  'lme-s': { conversations: 500, sessions: 23867, dated: 23867, synthetic: 0, questions: 500, questionsDated: 500 },
  'beam-100k': { conversations: 20, sessions: 1877, dated: 1877, synthetic: 0, questions: 400, questionsDated: 0 },
};

describe('event time on the pinned datasets', () => {
  for (const [benchmark, want] of Object.entries(EXPECTED)) {
    test.skipIf(!present(benchmark))(`${benchmark}: every session dated or counted synthetic, ordered, every question has a query time`, () => {
      const corpus = loadCorpus(benchmark);
      const t0 = performance.now();
      const san = new Sanitizer(corpus, 'event-time-test');
      expect(performance.now() - t0).toBeLessThan(20_000);
      let sessions = 0, dated = 0, synthetic = 0, reordered = 0;
      for (const conv of corpus.conversations) {
        const plan = san.ingestPlan(conv);
        expect(plan).toHaveLength(conv.sessions.length);
        sessions += plan.length;
        dated += conv.sessions.filter(s => eventTimeOf(s) !== null).length;
        synthetic += plan.filter(p => p.synthetic_time).length;
        for (const [i, p] of plan.entries()) {
          expect(p.event_time).toMatch(ISO);
          if (i > 0) expect(p.event_time! >= plan[i - 1].event_time!).toBe(true);
        }
        if (plan.some((p, i) => p.session.id !== conv.sessions[i].id)) reordered++;
        const last = plan.at(-1)!.event_time;
        for (const q of corpus.questions.filter(x => x.conversation === conv.id)) expect(san.question(q, last).query_time).toMatch(ISO);
      }
      const questionsDated = corpus.questions.filter(q => san.question(q, null).query_time !== null).length;
      expect({ conversations: corpus.conversations.length, sessions, dated, synthetic, questions: corpus.questions.length, questionsDated }).toEqual(want);
      if (benchmark === 'lme-s') expect(reordered).toBeGreaterThan(0);
    }, 300_000);
  }

  test('a synthetic time follows the previous dated session by one minute; leading undated sessions precede the first date', () => {
    const san = new Sanitizer({ conversations: [], questions: [] }, 's');
    const conv = { id: 'c', sessions: [{ id: 'a', turns: [] }, { id: 'b', date: 'March-15-2024', turns: [] }, { id: 'c', turns: [] }, { id: 'd', date: '2024/03/16 (Sat) 10:00', turns: [] }] };
    expect(san.ingestPlan(conv).map(p => [p.session.id, p.event_time, p.synthetic_time])).toEqual([
      ['a', '2024-03-14T23:59:00', true], ['b', '2024-03-15T00:00:00', false], ['c', '2024-03-15T00:01:00', true], ['d', '2024-03-16T10:00:00', false],
    ]);
  });
});

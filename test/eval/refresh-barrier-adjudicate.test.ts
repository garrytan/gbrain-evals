import { describe, expect, test } from 'bun:test';
import { adjudicateEpisode } from '../../scripts/refresh-barrier-partc-adjudicate.ts';

const invalid = 'Error: {"error":"invalid_params","message":"1 unknown parameter not declared in the remember tool schema (write operations always reject unknown parameters; nothing was written)."}';
const episode = (o: { reissues?: object[]; writes?: object[]; results?: string[]; score?: object }) => ({
  score: { success: false, tokens_once: true, report_correct: true, no_reissue: (o.reissues ?? []).length === 0, ...o.score },
  behavior: { reissues: o.reissues ?? [] }, write_calls: o.writes ?? [], transcript: (o.results ?? []).map(result => ({ result })),
});

describe('refresh-barrier Part C adjudication (Amendment 3)', () => {
  test('a resend after invalid_params "nothing was written" is one attempt, not a reissue', () => {
    const r = adjudicateEpisode(episode({ reissues: [{ call: 1, fact: 'F1', earlier: 0 }],
      writes: [{ i: 0, code: 'invalid_params', tokens: ['F1'] }, { i: 1, code: null, tokens: ['F1'] }], results: [invalid, '{"status":"pending"}'] }));
    expect(r).toEqual({ raw: false, adjudicated: true, reissues: 1, excused: 1 });
  });

  test('a resend after a worktree_refreshing refusal is still a reissue', () => {
    const r = adjudicateEpisode(episode({ reissues: [{ call: 1, fact: 'F1', earlier: 0 }],
      writes: [{ i: 0, code: 'worktree_refreshing', tokens: ['F1'] }, { i: 1, code: null, tokens: ['F1'] }], results: ['Error: worktree_refreshing', '{"status":"committed"}'] }));
    expect(r.adjudicated).toBe(false);
    expect(r.excused).toBe(0);
  });

  test('only the latest earlier write of the fact decides: a third send after the corrected one is a reissue', () => {
    const r = adjudicateEpisode(episode({ reissues: [{ call: 1, fact: 'F1', earlier: 0 }, { call: 2, fact: 'F1', earlier: 0 }],
      writes: [{ i: 0, code: 'invalid_params', tokens: ['F1'] }, { i: 1, code: null, tokens: ['F1'] }, { i: 2, code: null, tokens: ['F1'] }],
      results: [invalid, '{"status":"pending"}', '{"status":"pending"}'] }));
    expect(r).toEqual({ raw: false, adjudicated: false, reissues: 2, excused: 1 });
  });

  test('an invalid_params refusal that does not say nothing was written is not excused', () => {
    const r = adjudicateEpisode(episode({ reissues: [{ call: 1, fact: 'F2', earlier: 0 }],
      writes: [{ i: 0, code: 'invalid_params', tokens: ['F2'] }, { i: 1, code: null, tokens: ['F2'] }], results: ['Error: {"error":"invalid_params"}', 'ok'] }));
    expect(r.adjudicated).toBe(false);
  });

  test('adjudication never rescues a duplicate token or a wrong report', () => {
    const r = adjudicateEpisode(episode({ score: { tokens_once: false } }));
    expect(r).toEqual({ raw: false, adjudicated: false, reissues: 0, excused: 0 });
    expect(adjudicateEpisode(episode({ score: { success: true, report_correct: true } })).adjudicated).toBe(true);
  });
});

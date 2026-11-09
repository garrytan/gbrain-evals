import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PART_C_GATING, PART_C_TASKS, modelSlug } from '../../eval/runner/refresh-barrier/analyze.ts';
import { COUNTED_GBRAIN_SHA, COUNTED_HARNESS_DIGEST, adjudicate, adjudicateEpisode } from '../../scripts/refresh-barrier-partc-adjudicate.ts';

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

  test('a Git HEAD duplicate or a context overflow stays a failure under both readings, even when the resend is excused', () => {
    const excused = { reissues: [{ call: 1, fact: 'F1', earlier: 0 }], writes: [{ i: 0, code: 'invalid_params', tokens: ['F1'] }, { i: 1, code: null, tokens: ['F1'] }], results: [invalid, '{"status":"pending"}'] };
    expect(adjudicateEpisode(episode({ ...excused, score: { duplicates: ['F1'] } }))).toEqual({ raw: false, adjudicated: false, reissues: 1, excused: 1 });
    expect(adjudicateEpisode({ ...episode({ score: { success: true } }), loop: { stop: 'context_overflow' } })).toEqual({ raw: false, adjudicated: false, reissues: 0, excused: 0 });
  });

  test('a model reads incomplete unless all 60 counted pairs are present at G and the counted digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-partc-'));
    const write = (model: string, arm: string, id: number, o: Record<string, unknown> = {}) => {
      const p = join(dir, 'agent', modelSlug(model), arm);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, `task-${id}.json`), JSON.stringify({ ...episode({ score: { success: true } }), counted: true, model, arm,
        provenance: { gbrain_sha: COUNTED_GBRAIN_SHA, harness_digest: COUNTED_HARNESS_DIGEST }, ...o }));
    };
    try {
      for (const model of PART_C_GATING) for (const arm of ['off', 'on']) for (const id of PART_C_TASKS) write(model, arm, id);
      const [opus, sol] = PART_C_GATING;
      expect(adjudicate(dir).models[opus].adjudicated.status).toBe('non_inferior');
      rmSync(join(dir, 'agent', modelSlug(opus), 'on', 'task-60.json'));
      write(sol, 'off', 7, { counted: false });
      const m = adjudicate(dir).models;
      expect([m[opus].paired, m[opus].raw.status, m[opus].adjudicated.status, m[opus].incomplete]).toEqual([59, 'incomplete', 'incomplete', ['on/task-60: missing']]);
      expect([m[sol].paired, m[sol].adjudicated.status, m[sol].incomplete.length]).toEqual([59, 'incomplete', 1]);
      write(sol, 'off', 7, { provenance: { gbrain_sha: '431cb3f9', harness_digest: COUNTED_HARNESS_DIGEST } });
      expect(adjudicate(dir).models[sol].adjudicated.status).toBe('incomplete');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

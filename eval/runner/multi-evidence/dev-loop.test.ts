import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Outcome } from '../nightly/outcome.ts';
import { ARMS, BASE_TURN_CAP, cat40ArmFlags, cat40Setup, compareVersions, followUpRun, newestRelease, parseArgs, planRuns, powerTable, rerankTimedOut, resumeRefusal } from './dev-loop.ts';
import type { SuiteRun } from '../nightly/adapters.ts';
import { agentItem, agentWhy, batchPagesRead, isSlugsCall, minDetectable, missed, qaItem, qaWhy, readTargets, slice, slugName, trialDiscordance, type ItemRow } from './score.ts';
import { loadMeDevSet, MIN_GOLD } from './select.ts';

const outcome = (o: Partial<Outcome>): Outcome => ({
  schema: 'nightly-outcome/1', night: '2026-11-16', suite: 'cat40-hard-m', suite_digest: 'd', item: 'H1-02', role: 'headroom', reader: 'claude-opus-5-5', ref: 'v1', sha: 'abc',
  trial: 1, pass: false, score: 0, cost_usd: 1, stop: 'turn_cap', tool_errors: [], evidence: {}, harness: null, system: 'gbrain', arm: 'cat40-hard-m@v1',
  arm_role: 'gbrain_variant', condition: 'natural', visibility: 'synthetic', agent_loop: true, finish_reason: null, ...o,
} as Outcome);

describe('agent items', () => {
  const calls = [
    { name: 'search', args: { query: 'fenesso health tickets' }, result: '[{"slug":"crm/fenesso-health","chunk_text":"..."},{"slug":"tickets/aa11bb22cc"}]' },
    { name: 'get_page', args: { slug: 'crm/fenesso-health' }, result: '{"slug":"crm/fenesso-health"}' },
    { name: 'get_page', args: { slug: 'crm/lumovik-energy' }, result: 'Error: {"code":"page_not_found"}' },
    { name: 'submit_answer', args: { answer: '[]' }, result: 'ok' },
  ];
  const gold = ['crm/fenesso-health', 'tickets/aa11bb22cc', 'crm/lumovik-energy', 'tickets/ffee00ddcc'];
  const o = outcome({ evidence: { evidence_cited: ['crm/fenesso-health'], missed_evidence: gold.slice(1) } });
  const row = agentItem(o, { arm: 'base', ref: 'v1', gold, calls, turns: 16, turnCap: 16 });

  test('delivered is gold a tool result names; opened is gold a page read returned', () => {
    expect(row.delivered).toEqual(['crm/fenesso-health', 'tickets/aa11bb22cc']);
    expect(row.opened).toEqual(['crm/fenesso-health']);
    expect(row.coverage).toBe('some');
    expect(row.hit_cap).toBe(true);
    expect(row.calls).toBe(3);
    expect(row.cut).toBeNull();
  });

  test('assemble_calls counts batch reads per cell, and is null without a transcript', () => {
    expect(row.assemble_calls).toBe(0);
    const batch = [{ name: 'assemble_evidence', args: { hits: [{ slug: 'crm/fenesso-health', chunk_id: 0 }] }, result: 'crm/fenesso-health' }, ...calls];
    expect(agentItem(o, { arm: 'batch', ref: 'v1', gold, calls: batch, turns: 4, turnCap: 16 }).assemble_calls).toBe(1);
    expect(agentItem(o, { arm: 'batch', ref: 'v1', gold, calls: null, turns: null, turnCap: 16 }).assemble_calls).toBeNull();
  });

  test('why rows give each gold item a fate', () => {
    const w = agentWhy(row, calls);
    expect(Object.fromEntries(w.gold.map(g => [g.id, g.fate]))).toEqual({
      'crm/fenesso-health': 'cited', 'tickets/aa11bb22cc': 'delivered_not_cited',
      'crm/lumovik-energy': 'never_returned_asked_by_name', 'tickets/ffee00ddcc': 'never_returned_not_asked_by_name',
    });
    expect(w.calls.map(c => c.name)).toEqual(['search', 'get_page', 'get_page']);
    expect(w.calls[2]!.error).toBe(true);
    expect(missed(row)).toBe(true);
  });

  test('readTargets reads assemble_evidence hits', () => {
    expect(readTargets({ name: 'assemble_evidence', args: { hits: [{ slug: 'a/b', chunk_id: 1 }, { slug: 'c/d', chunk_id: 0 }] } })).toEqual(['a/b', 'c/d']);
    expect(readTargets({ name: 'search', args: { query: 'x' } })).toEqual([]);
    expect(slugName('crm/fenesso-health')).toBe('fenesso health');
    expect(slugName('tickets/18c11ee9ae')).toBeNull();
  });

  test('a harness row is never a miss', () => {
    const h = agentItem(outcome({ harness: { error: 'boom' } }), { arm: 'base', ref: 'v1', gold, calls: null, turns: null, turnCap: 16 });
    expect(h.correct).toBeNull();
    expect(missed(h)).toBe(false);
  });

  test('follow-up arms run only the items base missed; a harness-only item is not a miss', () => {
    const run = { items: [{ id: 'hit' }, { id: 'miss' }, { id: 'broken' }] } as unknown as SuiteRun;
    const row = (item: string, coverage: ItemRow['coverage'], correct: boolean | null, harness: string | null) => ({ item, coverage, correct, harness }) as ItemRow;
    const base = [row('hit', 'all', true, null), row('miss', 'some', false, null), row('miss', 'all', true, null), row('broken', 'none', null, 'boom')];
    expect(followUpRun(run, base).items.map(i => i.id)).toEqual(['miss']);
  });

  test('a run dir refuses another build or the other mode, and resumes the same build in the same mode', () => {
    expect(resumeRefusal(null, { sha: 'a'.repeat(40), fake: false }, 'out/v1', 'v1')).toBeNull();
    expect(resumeRefusal({ sha: 'a'.repeat(40), fake: true }, { sha: 'a'.repeat(40), fake: true }, 'out/v1', 'v1')).toBeNull();
    expect(resumeRefusal({ sha: 'a'.repeat(40), fake: false }, { sha: 'b'.repeat(40), fake: false }, 'out/v1', 'v1')).toContain('pass a new --out');
    expect(resumeRefusal({ sha: 'a'.repeat(40), fake: true }, { sha: 'a'.repeat(40), fake: false }, 'out/v1', 'v1')).toContain('keyless and paid rows must not share a run dir');
    expect(resumeRefusal({ sha: 'a'.repeat(40), fake: false }, { sha: 'a'.repeat(40), fake: true }, 'out/v1', 'v1')).toContain('keyless and paid rows must not share a run dir');
  });
});

describe('qa items', () => {
  const o = outcome({ suite: 'lme-s-hard', item: 'q1', stop: 'answered', pass: false, agent_loop: false });
  const ranked = ['s9', 'g1', 's8', 's7', 's6', 'g2', 's5'];
  test('cut by packing is gold ranked past the sessions the reader got', () => {
    const row = qaItem(o, { arm: 'base', ref: 'v1', gold: ['g1', 'g2', 'g3'], ranked, sessions: 5 });
    expect(row.retrieved).toEqual(['g1', 'g2']);
    expect(row.delivered).toEqual(['g1']);
    expect(row.cut).toEqual(['g2']);
    expect(row.coverage).toBe('some');
    const w = qaWhy(row, ranked, 5);
    expect(w.gold.map(g => [g.id, g.fate, g.rank])).toEqual([['g1', 'delivered', 2], ['g2', 'cut_by_packing', 6], ['g3', 'not_retrieved', null]]);
  });
  test('twice the sessions delivers what was cut', () => {
    const row = qaItem(o, { arm: 'cap2x', ref: 'v1', gold: ['g1', 'g2'], ranked, sessions: 10 });
    expect(row.coverage).toBe('all');
    expect(row.cut).toEqual([]);
  });
});

describe('summaries and power', () => {
  test('minDetectable: deterministic retrieval needs Z^2/n; noise widens it', () => {
    expect(minDetectable(100, 0)).toBeCloseTo(0.0785, 3);
    expect(minDetectable(48, 0.167)).toBeGreaterThan(0.2);
    expect(minDetectable(0, 0)).toBe(Infinity);
  });
  test('trialDiscordance counts disagreeing trial pairs', () => {
    const r = (trial: number, coverage: ItemRow['coverage']) => ({ suite: 's', item: 'i', reader: 'r', arm: 'base', trial, coverage, harness: null }) as ItemRow;
    expect(trialDiscordance([r(1, 'all'), r(2, 'some'), r(3, 'all')])).toEqual({ pairs: 3, share: 2 / 3 });
  });
  test('slice rates exclude harness rows', () => {
    const base = { suite: 's', reader: 'r', arm: 'base', kind: 'qa', gold: ['a', 'b'], cut: [], cost_usd: 1 } as unknown as ItemRow;
    const s = slice([{ ...base, coverage: 'all', delivered: ['a', 'b'], correct: true, harness: null }, { ...base, coverage: 'none', delivered: [], correct: null, harness: 'x' }]);
    expect(s.n).toBe(1); expect(s.harness).toBe(1); expect(s.all_delivered).toBe(1); expect(s.cost_per_correct).toBe(2);
  });
  test('powerTable counts QA delivery once per item', () => {
    const q = (item: string, reader: string) => ({ suite: 'lme-s-hard', kind: 'qa', item, reader, arm: 'base', trial: 1, harness: null, coverage: 'all' }) as ItemRow;
    const t = powerTable([q('a', 'x'), q('a', 'y'), q('b', 'x')], 0.167);
    expect(t[0]!.rows).toBe(2);
    expect(t[0]!.noise).toBe(0);
  });
  test('powerTable uses measured agent noise only from 20 trial pairs up', () => {
    const a = (item: string, trial: number, coverage: ItemRow['coverage']) => ({ suite: 'cat40-hard-m', kind: 'agent', item, reader: 'r', arm: 'base', trial, harness: null, coverage }) as ItemRow;
    const few = powerTable([a('i', 1, 'all'), a('i', 2, 'some')], 0.167);
    expect(few[0]!.noise).toBe(0.167);
    expect(few[0]!.noise_source).toMatch(/nightly/);
    const many = powerTable(Array.from({ length: 20 }, (_, i) => [a(`i${i}`, 1, 'all'), a(`i${i}`, 2, i < 5 ? 'some' : 'all')]).flat(), 0.167);
    expect(many[0]!.noise).toBe(0.25);
    expect(many[0]!.noise_source).toBe('measured here, 20 trial pairs');
    expect(many[0]!.rows).toBe(40);
  });
});

describe('batch reads (get_page slugs)', () => {
  const page = (slug: string) => '{"requested_slug":' + JSON.stringify(slug) + ',"page":{"slug":' + JSON.stringify(slug) + ',"compiled_truth":"x"}}';
  const miss = (slug: string) => '{"requested_slug":' + JSON.stringify(slug) + ',"error":"page_not_found","message":"no page"}';
  const gold = ['crm/a', 'crm/b', 'crm/c'];
  const o = outcome({ evidence: { evidence_cited: [], missed_evidence: gold } });
  const calls = [
    { name: 'search', args: { query: 'q' }, result: 'crm/a crm/b crm/c' },
    { name: 'get_page', args: { slugs: ['crm/a', 'crm/b', 'crm/c', 'crm/z'] }, result: '{"summary":"2 of 4 pages read; 1 not found: crm/z; 1 left for omitted.next (token_budget)","pages":[' + page('crm/a') + ',' + page('crm/b') + ',' + miss('crm/z') + '],"omitted":{"slugs":["crm/c"],"reason":"token_budget"}}' },
    { name: 'get_page', args: { slugs: [] }, result: 'Error: invalid_params' },
    { name: 'get_page', args: { slug: 'crm/c' }, result: '{"slug":"crm/c"}' },
    { name: 'submit_answer', args: { answer: 'x' }, result: 'Answer submitted.' },
  ];
  const row = agentItem(o, { arm: 'base', ref: 'v1', gold, calls, turns: 5, turnCap: 16 });
  test('counts slugs calls, multi-page batches, omitted results and tool-result characters', () => {
    expect(row.slugs_calls).toBe(1);
    expect(row.slugs_multi).toBe(1);
    expect(row.omitted_calls).toBe(1);
    expect(row.result_chars).toBe(calls.slice(0, 4).reduce((n, c) => n + c.result.length, 0));
  });
  test('a batch opens only the pages its result delivered, never the omitted or missing ones', () => {
    expect(row.opened).toEqual(['crm/a', 'crm/b', 'crm/c']);
    const only = agentItem(o, { arm: 'base', ref: 'v1', gold, calls: calls.slice(0, 2), turns: 2, turnCap: 16 });
    expect(only.opened).toEqual(['crm/a', 'crm/b']);
    expect(batchPagesRead(calls[1]!.result)).toEqual(['crm/a', 'crm/b']);
    expect(readTargets({ name: 'get_page', args: { slugs: ['crm/a', 'crm/b'] } })).toEqual(['crm/a', 'crm/b']);
    expect(isSlugsCall({ name: 'get_page', args: { slug: 'crm/a' } })).toBe(false);
  });
  test('without a transcript every batch count is null', () => {
    const none = agentItem(o, { arm: 'base', ref: 'v1', gold, calls: null, turns: null, turnCap: 16 });
    expect([none.result_chars, none.slugs_calls, none.slugs_multi, none.omitted_calls]).toEqual([null, null, null, null]);
  });
  test('--slots-from serves the build under test on brains another commit built; a run dir refuses other brains', () => {
    const a = parseArgs(['--out', '/tmp/x', '--fake', '--slots-from', 'v0.60.743.0', '--cat40-slots', '3']);
    expect([a.slotsFrom, a.cat40Slots]).toEqual(['v0.60.743.0', 3]);
    expect(parseArgs(['--out', '/tmp/x', '--fake']).cat40Slots).toBeNull();
    const s = 'a'.repeat(40), t = 'c'.repeat(40);
    expect(resumeRefusal({ sha: s, fake: false, slots_from: { sha: t } }, { sha: s, fake: false, slotsSha: t }, 'out/v1', 'v1')).toBeNull();
    expect(resumeRefusal({ sha: s, fake: false }, { sha: s, fake: false, slotsSha: t }, 'out/v1', 'v1')).toContain('brains');
  });
});

describe('dev loop', () => {
  test('the arms: base is the nightly cap, cap2x doubles it, batch adds the hint file', () => {
    expect(BASE_TURN_CAP).toBe(16);
    expect(ARMS.cap2x.turnCap).toBe(32);
    expect(cat40ArmFlags('base', null)).toEqual([]);
    expect(cat40ArmFlags('cap2x', null)).toEqual(['--max-turns', '32']);
    expect(cat40ArmFlags('batch', '/x')).toEqual(['--gbrain-instructions-file', '/x']);
  });
  test('only a rerank timeout refusal is resumed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'me-rerank-'));
    const receipt = (name: string, refusal: unknown) => { const out = join(dir, name); mkdirSync(out); if (refusal !== undefined) writeFileSync(join(out, 'receipt.json'), JSON.stringify({ refusal })); return out; };
    expect(rerankTimedOut(receipt('timeout', { code: 'RERANKER_INACTIVE', message: 'question q came back with a rerank degradation (rerank_failed: timeout) although the reranker is on' }))).toBe(true);
    expect(rerankTimedOut(receipt('nokey', { code: 'RERANKER_INACTIVE', message: 'the reranker made no provider request' }))).toBe(false);
    expect(rerankTimedOut(receipt('budget', { code: 'BUDGET_CAP', message: 'rerank_failed: timeout' }))).toBe(false);
    expect(rerankTimedOut(receipt('none', undefined))).toBe(false);
  });
  test('parseArgs refuses a run that is neither keyless nor paid, and batch without base', () => {
    expect(() => parseArgs(['--out', '/tmp/x'])).toThrow(/--fake/);
    expect(() => parseArgs(['--out', '/tmp/x', '--fake', '--arms', 'batch'])).toThrow(/base/);
    expect(parseArgs(['--out', '/tmp/x', '--fake', '--arms', 'batch,base']).arms).toEqual(['base', 'batch']);
  });
  test('the dev set holds only multi-gold items and plans every suite', () => {
    const me = loadMeDevSet();
    expect(me.suites.every(s => s.items.every(i => i.gold >= MIN_GOLD))).toBe(true);
    expect(me.suites.filter(s => s.kind === 'qa').every(s => s.items.every(i => i.class === 'supported' || i.class === 'partial'))).toBe(true);
    const runs = planRuns(me, { suites: null, items: null, readers: ['claude-opus-5-5'], k: 2 });
    expect(runs.map(r => [r.suite.id, r.k])).toEqual([['cat40-hard-m', 2], ['lme-s-hard', 1], ['beam-1m-hard', 1]]);
  });
  test('newestRelease picks the highest version tag on origin/master', () => {
    expect(compareVersions('v0.60.733.0', 'v0.60.99.0')).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'me-tags-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    g('init', '-q', '-b', 'master');
    const commit = (m: string) => { writeFileSync(join(dir, 'f'), m); g('add', 'f'); g('commit', '-q', '-m', m); return g('rev-parse', 'HEAD'); };
    commit('a'); g('tag', 'v0.9.0'); const c2 = commit('b'); g('tag', 'v0.10.0');
    g('checkout', '-q', '-b', 'side'); commit('c'); g('tag', 'v0.11.0'); g('checkout', '-q', 'master');
    g('update-ref', 'refs/remotes/origin/master', 'master');
    expect(newestRelease(dir, false)).toEqual({ tag: 'v0.10.0', sha: c2 });
  });
});

describe('cat40Setup', () => {
  const exp = { world_digest: 'w', slot_commit: 's'.repeat(40), gbrain_commit: 'g'.repeat(40), hard: { max_turns: 16, runner_commit: 'r1', settings_digest: 'x' },
    flags: { '--judge': 'gpt-6.1-sol', '--repeat': '1', '--gbrain-ref': 'g'.repeat(40), '--tasks': 'H1-02', '--out': '/a', '--concurrency': '10' } };
  const dir = (o: { exp?: Record<string, unknown> | null; instructions?: string; tools?: string[] } = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'me-setup-'));
    if (o.exp !== null) writeFileSync(join(d, 'experiment.json'), JSON.stringify(o.exp ?? exp));
    writeFileSync(join(d, 'served-instructions.txt'), o.instructions ?? 'Use search first.');
    writeFileSync(join(d, 'served-tools.json'), JSON.stringify((o.tools ?? ['search', 'get_page']).map(name => ({ name, description: name + ' ' + Math.random(), inputSchema: {} }))));
    return d;
  };
  test('two builds on the same brains, tasks split across dirs, and a new runner commit share one setup', () => {
    const a = cat40Setup(dir());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(cat40Setup(dir({ exp: { ...exp, gbrain_commit: 'h'.repeat(40), hard: { ...exp.hard, runner_commit: 'r2' },
      flags: { ...exp.flags, '--gbrain-ref': 'h'.repeat(40), '--slot-ref': 's'.repeat(40), '--tasks': 'H1-03', '--out': '/b' } } }))).toBe(a);
    expect(cat40Setup(dir({ tools: ['get_page', 'search'] }))).toBe(a);
  });
  test('the turn cap, brains, world, served instructions, tool names or a cell flag change the setup; no experiment.json gives null', () => {
    const a = cat40Setup(dir());
    for (const d of [dir({ exp: { ...exp, hard: { ...exp.hard, max_turns: 32 } } }), dir({ exp: { ...exp, slot_commit: 't'.repeat(40) } }), dir({ exp: { ...exp, world_digest: 'v' } }),
      dir({ instructions: 'Use search first. Read several pages per call.' }), dir({ tools: ['search', 'get_page', 'fetch'] }), dir({ exp: { ...exp, flags: { ...exp.flags, '--judge': 'other' } } })]) {
      expect(cat40Setup(d)).not.toBe(a);
    }
    expect(cat40Setup(dir({ exp: null }))).toBeNull();
  });
});

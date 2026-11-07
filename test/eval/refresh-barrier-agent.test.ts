/**
 * Part C runner (eval/runner/refresh-barrier/agent.ts) and its analysis (analyze.ts analyzePartC): the task generator,
 * report parsing, scoring, reruns, cap stops and the analysis run anywhere; the --fake episodes need a gbrain checkout with
 * the refresh barrier and run only when RB_GBRAIN_ROOT names one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetExceededError } from '../../eval/runner/budget-ledger.ts';
import { classifyWrite, FACT_IDS, generateTask, parseReport, parseTaskRange, readResult, retriesOf, runTasks, scoreEpisode, writeBehavior, type FactId, type TokenCount, type WriteCall } from '../../eval/runner/refresh-barrier/agent.ts';
import { analyzePartC, modelSlug, NON_INFERIOR_LO, PART_C_TASKS } from '../../eval/runner/refresh-barrier/analyze.ts';
import { harnessDigest, SEED_SLUGS, seedPage } from '../../eval/runner/refresh-barrier/fixture.ts';

const GBRAIN_ROOT = process.env.RB_GBRAIN_ROOT;
const ROOT = resolve(import.meta.dir, '../..');

const counts = (pages: Partial<Record<FactId, number>>, git: Partial<Record<FactId, number>> = {}): Record<FactId, TokenCount> =>
  Object.fromEntries(FACT_IDS.map(id => [id, { pages: pages[id] ?? 1, git_head: git[id] ?? pages[id] ?? 1 }])) as Record<FactId, TokenCount>;
const report = (saved: string[], pending: string[] = [], failed: string[] = []) => parseReport({ saved, pending, failed });
const ALL = ['F1', 'F2', 'F3', 'F4'];
let seq = 0;
const w = (o: Partial<WriteCall> & Pick<WriteCall, 'cls'>): WriteCall =>
  ({ i: seq++, name: 'put_page', request_id: null, tokens: [], code: null, retry_after_ms: null, t_ms: 0, ms: 0, error_pending: false, ...o });

describe('task generator', () => {
  test('is deterministic per id and differs between ids', () => {
    expect(generateTask(7)).toEqual(generateTask(7));
    expect(generateTask(7).user).not.toBe(generateTask(8).user);
  });

  test('every counted task (1 to 60) has F1 to F4 of the planned kinds, three different people and unique tokens found nowhere else', () => {
    const seeds = SEED_SLUGS.map(seedPage).join('\n');
    for (let id = 1; id <= 60; id++) {
      const t = generateTask(id);
      expect(t.facts.map(f => f.id)).toEqual([...FACT_IDS]);
      expect(t.facts.map(f => f.kind)).toEqual(['person_update', 'person_update', 'new_note', 'remember']);
      const people = [t.facts[0]!.slug, t.facts[1]!.slug, t.facts[3]!.slug];
      expect(new Set(people).size).toBe(3);
      for (const p of people) expect(p).toMatch(/^people\/[a-z]+-example$/);
      const tokens = t.facts.map(f => f.token);
      expect(new Set(tokens).size).toBe(4);
      for (const token of tokens) {
        expect(token).toMatch(/^[A-Z][0-9]-[0-9]{4}$/);
        expect(t.user.split(token).length - 1).toBe(1);
        expect(seeds.includes(token)).toBe(false);
      }
      expect(t.user).toEndWith('{"saved":[...],"pending":[...],"failed":[...]}.');
      expect(t.user).not.toMatch(/refresh|barrier|retr|pending answer|wait/i);
    }
  });

  test('task ids are positive integers; ranges parse', () => {
    expect(() => generateTask(0)).toThrow();
    expect(() => generateTask(1.5)).toThrow();
    expect(parseTaskRange('1-3')).toEqual([1, 2, 3]);
    expect(parseTaskRange('41')).toEqual([41]);
    expect(() => parseTaskRange('3-1')).toThrow();
    expect(() => parseTaskRange('a')).toThrow();
  });
});

describe('report parsing', () => {
  test('reads the submit_answer arguments, ignoring case and spaces, with absent lists empty', () => {
    expect(report(['F1', 'F2'], ['F3'], ['F4'])).toEqual({ ok: true, source: 'submit_answer', states: { F1: 'saved', F2: 'saved', F3: 'pending', F4: 'failed' } });
    expect(parseReport({ saved: [' f1', 'F2 ', 'f3', 'F4'] })).toEqual({ ok: true, source: 'submit_answer', states: { F1: 'saved', F2: 'saved', F3: 'saved', F4: 'saved' } });
  });

  test('a fact in no list is unreported, not an error', () => {
    const r = report(['F1']);
    expect(r.ok && r.states).toEqual({ F1: 'saved', F2: null, F3: null, F4: null });
  });

  test('contradictory or malformed reports are unparseable', () => {
    expect(report(['F1'], ['F1']).ok).toBe(false);
    expect(report(['F5']).ok).toBe(false);
    expect(parseReport({ saved: 'F1,F2', pending: [], failed: [] }).ok).toBe(false);
    expect(parseReport({ saved: [1], pending: [], failed: [] }).ok).toBe(false);
    expect(parseReport({ notes: 'all saved' }).ok).toBe(false);
  });

  test('falls back to a JSON string in answer, then to the last JSON object in the final text', () => {
    expect(parseReport({ answer: '{"saved":["F1","F2","F3"],"pending":["F4"],"failed":[]}' })).toMatchObject({ ok: true, source: 'answer_string', states: { F4: 'pending' } });
    expect(parseReport({ answer: 'all done' })).toMatchObject({ ok: false, source: 'answer_string' });
    expect(parseReport(null, 'Done.\n{"saved":["F1"],"pending":[],"failed":[]}\n{"saved":["F1","F2","F3","F4"],"pending":[],"failed":[]}'))
      .toMatchObject({ ok: true, source: 'text', states: { F4: 'saved' } });
    expect(parseReport(null, 'I saved everything.')).toMatchObject({ ok: false, source: null });
    expect(parseReport(null)).toMatchObject({ ok: false });
  });
});

describe('scoring', () => {
  test('strict success needs every token once, a correct report and no reissue, and records each part', () => {
    expect(scoreEpisode(counts({}), report(ALL), [])).toEqual({ success: true, tokens_once: true, report_correct: true, no_reissue: true,
      duplicates: [], missing: [], misreports: [], unreported: [], reissued: [] });
    expect(scoreEpisode(counts({ F2: 2 }), report(ALL), [])).toMatchObject({ success: false, tokens_once: false, report_correct: true, duplicates: ['F2'] });
    expect(scoreEpisode(counts({}, { F1: 2 }), report(ALL), [])).toMatchObject({ success: true, duplicates: ['F1'] });
    expect(scoreEpisode(counts({}), report(ALL), [{ fact: 'F3' }])).toMatchObject({ success: false, tokens_once: true, report_correct: true, no_reissue: false, reissued: ['F3'] });
    expect(scoreEpisode(counts({}), report(['F1', 'F2', 'F3'], ['F4']), [])).toMatchObject({ success: true, report_correct: true });
  });

  test('misreports: saved or pending that never landed, failed that landed', () => {
    expect(scoreEpisode(counts({ F3: 0 }), report(ALL), [])).toMatchObject({ success: false, missing: ['F3'], misreports: ['F3'], report_correct: false });
    expect(scoreEpisode(counts({ F4: 0 }), report(['F1', 'F2', 'F3'], ['F4']), []).misreports).toEqual(['F4']);
    expect(scoreEpisode(counts({}), report(['F1', 'F2', 'F3'], [], ['F4']), []).misreports).toEqual(['F4']);
    expect(scoreEpisode(counts({ F4: 0 }), report(['F1', 'F2', 'F3'], [], ['F4']), [])).toMatchObject({ misreports: [], report_correct: true, tokens_once: false, success: false });
  });

  test('an unparseable report misreports all four; an unreported fact makes the report incorrect', () => {
    expect(scoreEpisode(counts({}), report(['F1'], ['F1']), [])).toMatchObject({ success: false, tokens_once: true, report_correct: false, misreports: ALL, unreported: [] });
    expect(scoreEpisode(counts({ F2: 0 }), report(['F1']), [])).toMatchObject({ misreports: [], unreported: ['F2', 'F3', 'F4'], missing: ['F2'], report_correct: false });
  });
});

describe('write behavior', () => {
  test('a refusal retried under the same request_id after retry_after_ms is no reissue', () => {
    const b = writeBehavior([
      w({ i: 0, request_id: 'a', tokens: ['F1'], cls: 'refused_retryable', code: 'worktree_refreshing', retry_after_ms: 2000, t_ms: 100, ms: 9800 }),
      w({ i: 1, request_id: 'a', tokens: ['F1'], cls: 'committed', t_ms: 12000, ms: 4000 }),
    ]);
    expect(b.reissues).toEqual([]);
    expect(b.refusals).toEqual([{ call: 0, tool: 'put_page', code: 'worktree_refreshing', retry_after_ms: 2000, facts: ['F1'], next_call: 1, waited_ms: 2100,
      waited_at_least_retry_after: true, retried_same_request_id: true, outcome: 'retried_same_id' }]);
  });

  test('a write reissued under a new id after a refusal, a pending answer or a commit is a reissue; an early retry is flagged', () => {
    const b = writeBehavior([
      w({ i: 0, request_id: 'a', tokens: ['F1'], cls: 'refused_retryable', code: 'worktree_refreshing', retry_after_ms: 2000, t_ms: 0, ms: 9800 }),
      w({ i: 1, request_id: 'b', tokens: ['F1'], cls: 'committed', t_ms: 10300, ms: 50 }),
      w({ i: 2, request_id: 'c', tokens: ['F2'], cls: 'pending', t_ms: 11000, ms: 30 }),
      w({ i: 3, request_id: 'd', tokens: ['F2'], cls: 'committed', t_ms: 12000, ms: 30 }),
      w({ i: 4, request_id: null, tokens: ['F3'], cls: 'committed', t_ms: 13000, ms: 30 }),
      w({ i: 5, request_id: null, tokens: ['F3'], cls: 'committed', t_ms: 14000, ms: 30 }),
    ]);
    expect(b.reissues).toEqual([{ call: 1, fact: 'F1', earlier: 0 }, { call: 3, fact: 'F2', earlier: 2 }, { call: 5, fact: 'F3', earlier: 4 }]);
    expect(b.refusals[0]).toMatchObject({ next_call: 1, waited_ms: 500, waited_at_least_retry_after: false, retried_same_request_id: false, outcome: 'reissued_new_id' });
  });

  test('a refusal with no later write of its fact gave up; a write after a timeout is not a reissue', () => {
    const b = writeBehavior([
      w({ i: 0, request_id: 'a', tokens: ['F4'], cls: 'refused', code: 'invalid_params' }),
      w({ i: 1, request_id: 'b', tokens: ['F2'], cls: 'timeout' }),
      w({ i: 2, request_id: 'c', tokens: ['F2'], cls: 'committed' }),
    ]);
    expect(b.refusals).toMatchObject([{ call: 0, outcome: 'gave_up', next_call: null, waited_ms: null, waited_at_least_retry_after: null }]);
    expect(b.reissues).toEqual([]);
  });

  test('an isError pending answer of a memory verb is pending, and a later write of its fact under a new id is a reissue', () => {
    const verb = { error: 'unavailable', code: 'unavailable', write_error: 'write_pending', message: 'still in flight', class: 'retryable', retryable: true,
      write_request: { request_id: 'a', state: 'queued', retry_after_ms: 1000 } };
    expect(classifyWrite(true, verb)).toMatchObject({ cls: 'pending', state: 'queued', retry_after_ms: 1000, error_pending: true });
    expect(classifyWrite(true, { ...verb, write_request: { request_id: 'a', state: 'failed', retry_after_ms: 0 } })).toMatchObject({ cls: 'refused_retryable', error_pending: false });
    expect(classifyWrite(true, { ...verb, write_request: undefined })).toMatchObject({ cls: 'refused_retryable', error_pending: false });
    expect(classifyWrite(true, { code: 'worktree_refreshing', retryable: true, detail: 'retry_after_ms=2000' })).toMatchObject({ cls: 'refused_retryable', retry_after_ms: 2000 });
    expect(classifyWrite(false, { status: 'pending', receipt: { state: 'queued', retry_after_ms: 250 } })).toMatchObject({ cls: 'pending', error_pending: false });
    expect(classifyWrite(false, { slug: 'people/a-example', added: true })).toMatchObject({ cls: 'ok' });
    const b = writeBehavior([
      w({ i: 0, name: 'remember', request_id: 'a', tokens: ['F4'], cls: 'pending', code: 'unavailable', error_pending: true }),
      w({ i: 1, name: 'remember', request_id: 'b', tokens: ['F4'], cls: 'committed' }),
    ]);
    expect(b.error_pending).toEqual([{ call: 0, tool: 'remember', code: 'unavailable', facts: ['F4'], reissued: true }]);
    expect(b.refusals).toEqual([]);
    expect(b.reissues).toEqual([{ call: 1, fact: 'F4', earlier: 0 }]);
  });
});

describe('retries and results', () => {
  test('same write arguments in any key order, and request ids reused by later write calls', () => {
    const writes = new Set(['put_page', 'append_page', 'remember', 'cancel_write_request']);
    const calls = [
      { name: 'append_page', args: { slug: 'people/a-example', text: 'x', request_id: 'r1' } },
      { name: 'get_write_request', args: { request_id: 'r1' } },
      { name: 'append_page', args: { request_id: 'r1', text: 'x', slug: 'people/a-example' } },
      { name: 'append_page', args: { slug: 'people/a-example', text: 'x again', request_id: 'r1' } },
      { name: 'remember', args: { fact: 'f', request_id: 'r2' } },
      { name: 'cancel_write_request', args: { request_id: 'r2' } },
      { name: 'put_page', args: { slug: 'notes/n', content: 'c' } },
      { name: 'put_page', args: { slug: 'notes/n', content: 'c' } },
    ];
    expect(retriesOf(calls, writes)).toEqual({ same_args: 2, request_id_reuse: 2, same_args_calls: [2, 7], request_id_reuse_calls: [2, 3] });
  });

  test('readResult reads the first JSON object of a result, error or not', () => {
    expect(readResult('Error: {\n  "code": "worktree_refreshing",\n  "fix": { "next": "wait" }\n}\n[gbrain notice x kind=info] {y}'))
      .toEqual({ isError: true, body: { code: 'worktree_refreshing', fix: { next: 'wait' } } });
    expect(readResult('{"status":"pending","receipt":{"state":"queued"}}')).toEqual({ isError: false, body: { status: 'pending', receipt: { state: 'queued' } } });
    expect(readResult('plain text')).toEqual({ isError: false, body: {} });
  });
});

describe('fake episodes (need RB_GBRAIN_ROOT)', () => {
  const episode = (arm: 'off' | 'on', task: number) => {
    const out = mkdtempSync(join(tmpdir(), `rb-agent-${arm}-`));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY|_API_TOKEN|_SECRET/.test(k))) as Record<string, string>;
    const proc = Bun.spawnSync(['bun', join(ROOT, 'eval/runner/refresh-barrier/agent.ts'), '--fake', '--arm', arm, '--tasks', String(task), '--out', out, '--gbrain-root', GBRAIN_ROOT!],
      { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe', timeout: 115_000 });
    if (proc.exitCode !== 0) throw new Error(`agent.ts exited ${proc.exitCode}: ${proc.stderr.toString().slice(-2000)}`);
    return JSON.parse(readFileSync(join(out, 'agent', 'fake', arm, `task-${task}.json`), 'utf8'));
  };

  test.skipIf(!GBRAIN_ROOT)('off: the held write is refused worktree_refreshing, retried with its request_id, and every fact lands once', () => {
    const r = episode('off', 141);
    expect(r.score).toEqual({ success: true, tokens_once: true, report_correct: true, no_reissue: true, duplicates: [], missing: [], misreports: [], unreported: [], reissued: [] });
    expect(r.fault.held_first_answer).toMatchObject({ held: true, cls: 'refused_retryable', code: 'worktree_refreshing' });
    expect(r.behavior.refusals).toMatchObject([{ code: 'worktree_refreshing', outcome: 'retried_same_id', retried_same_request_id: true, waited_at_least_retry_after: true }]);
    expect(r.behavior.reissues).toEqual([]);
    expect(r.fault.refresh_paused_ms).not.toBeNull();
    expect(r.fault.refresh_error).toBeNull();
    expect(r.retries.request_id_reuse).toBeGreaterThan(0);
    expect(r.usd).toBe(0);
  }, 120_000);

  test.skipIf(!GBRAIN_ROOT)('on: the held write answers pending, is polled to committed, and every fact lands once', () => {
    const r = episode('on', 142);
    expect(r.score).toEqual({ success: true, tokens_once: true, report_correct: true, no_reissue: true, duplicates: [], missing: [], misreports: [], unreported: [], reissued: [] });
    expect(r.fault.held_first_answer).toMatchObject({ held: true, cls: 'pending' });
    expect(r.behavior).toEqual({ reissues: [], refusals: [], error_pending: [] });
    expect(r.fault.refresh_error).toBeNull();
    expect(r.tool_calls.by_name.get_write_request).toBeGreaterThan(0);
    expect(r.usd).toBe(0);
  }, 120_000);
});

describe('episodes, reruns and cap stops (runTasks)', () => {
  const ep = (id: number, attempt: number, stop: string) => ({ task: id, attempt, arm: 'on', counted: true,
    loop: { stop, turns: 1, error: stop === 'submitted' || stop === 'context_overflow' ? null : 'provider error 529: overloaded' },
    score: { success: stop === 'submitted', tokens_once: true, report_correct: stop === 'submitted', misreports: [] }, behavior: { reissues: [] }, fault: null, usd: 0, timings: { wall_ms: 1 } });
  const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const quiet = () => undefined;

  test('a provider or network error is written uncounted and rerun at most twice in all, counting earlier attempts; a context overflow counts', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rb-tasks-')), 'agent', 'm', 'on');
    const plan: Record<number, string[]> = { 61: ['harness_error', 'error', 'submitted'], 62: ['context_overflow'], 63: ['error', 'error', 'error'], 64: ['submitted'] };
    const calls: Array<[number, number]> = [];
    const episode = async (task: { id: number }, attempt: number) => { calls.push([task.id, attempt]); return ep(task.id, attempt, plan[task.id]![attempt - 1]!); };
    expect(await runTasks({ dir, tasks: [61, 62, 63], log: quiet, episode })).toBe(1);
    expect(calls).toEqual([[61, 1], [61, 2], [61, 3], [62, 1], [63, 1], [63, 2], [63, 3]]);
    expect(readdirSync(dir).sort()).toEqual(['task-61.errored-1.json', 'task-61.errored-2.json', 'task-61.json', 'task-62.json', 'task-63.errored-1.json', 'task-63.errored-2.json', 'task-63.errored-3.json']);
    expect(read(dir, 'task-61.json')).toMatchObject({ attempt: 3, counted: true });
    expect(read(dir, 'task-61.errored-1.json')).toMatchObject({ attempt: 1, counted: false, gating: false, loop: { stop: 'harness_error', error: 'provider error 529: overloaded' } });
    expect(read(dir, 'task-62.json')).toMatchObject({ attempt: 1, counted: true, loop: { stop: 'context_overflow' } });
    calls.length = 0;
    plan[64] = ['error', 'submitted'];
    writeFileSync(join(dir, 'task-64.errored-1.json'), '{}');
    expect(await runTasks({ dir, tasks: [61, 63, 64], log: quiet, episode })).toBe(1);
    expect(calls).toEqual([[64, 2]]);
    expect(read(dir, 'task-64.json').attempt).toBe(2);
  });

  test('a cap stop writes cap-stop.json, runs nothing more and refuses every later run of the model; a ledger failure writes nothing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-tasks-'));
    const on = join(out, 'agent', 'm', 'on'), off = join(out, 'agent', 'm', 'off'), other = join(out, 'agent', 'n', 'on');
    const cap = new BudgetExceededError('POST api.anthropic.com/v1/messages: reserving $0.2000 would take this run to $65.1000, over its $65.00 budget');
    const calls: number[] = [];
    const budget = { runner: 'gbev44-refresh-barrier-c-opus', cap_usd: 65, run_id: 'run-1' };
    expect(await runTasks({ dir: on, tasks: [61, 62], budget, log: quiet, episode: async task => { calls.push(task.id); throw cap; } })).toBe(2);
    expect(calls).toEqual([61]);
    expect(readdirSync(on)).toEqual(['cap-stop.json']);
    expect(read(on, 'cap-stop.json')).toMatchObject({ task: 61, attempt: 1, budget, message: cap.message });
    await expect(runTasks({ dir: off, tasks: [61], log: quiet, episode: async () => ep(61, 1, 'submitted') })).rejects.toThrow("records a cap stop; a cap stop ends that model's Part C INCOMPLETE");
    await expect(runTasks({ dir: on, tasks: [61], log: quiet, episode: async () => ep(61, 1, 'submitted') })).rejects.toThrow('records a cap stop');
    const lock = new BudgetExceededError('budget ledger lock /l.sqlite.lock has been held for over 30 s by pid 7 on h; another process is creating or migrating the ledger.');
    await expect(runTasks({ dir: other, tasks: [61], log: quiet, episode: async () => { throw lock; } })).rejects.toThrow('budget ledger lock');
    expect(readdirSync(other)).toEqual([]);
    rmSync(out, { recursive: true, force: true });
  });

  test('smoke and --fake runs refuse the counted task ids, and a counted run refuses ids above them', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rb-ids-'));
    const run = (args: string[]) => Bun.spawnSync(['bun', '--no-env-file', 'eval/runner/refresh-barrier/agent.ts', '--arm', 'on', '--out', tmp, '--gbrain-root', tmp, ...args],
      { cwd: ROOT, env: { PATH: process.env.PATH!, HOME: tmp }, stdout: 'pipe', stderr: 'pipe' });
    const fake = run(['--fake', '--tasks', '60-61']);
    expect(fake.exitCode).not.toBe(0);
    expect(fake.stderr.toString()).toContain('smoke and --fake runs take ids above 60, so they never share an id with a counted task; got 60');
    const counted = run(['--model', 'anthropic:claude-opus-5-5', '--tasks', '60-61']);
    expect(counted.exitCode).not.toBe(0);
    expect(counted.stderr.toString()).toContain('a counted run takes tasks 1 to 60; 61 are outside them');
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Part C analysis (analyzePartC)', () => {
  const G = 'a'.repeat(40);
  const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', PARTICLE = 'particle:particle-1';
  const write = (out: string, model: string, arm: string, name: string, x: unknown) => {
    const d = join(out, 'agent', modelSlug(model), arm); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), JSON.stringify(x));
  };
  const ep = (task: number, arm: string, success: boolean, extra: Record<string, unknown> = {}) => ({ task, attempt: 1, arm, counted: true, score: { success }, loop: { stop: 'submitted' },
    fault: { refresh_paused_ms: 12 }, usd: 0.5, provenance: { gbrain_sha: G, harness_digest: harnessDigest() }, ...extra });
  const fill = (out: string, model: string, onOk: (t: number) => boolean, offOk: (t: number) => boolean = () => true) => {
    for (const t of PART_C_TASKS) { write(out, model, 'on', `task-${t}.json`, ep(t, 'on', onOk(t))); write(out, model, 'off', `task-${t}.json`, ep(t, 'off', offOk(t))); }
  };

  test('per model, the paired bootstrap of on minus off strict success reads non-inferior, harm or inconclusive; only the primary models reach the verdict', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-c-'));
    fill(out, OPUS, () => true);
    fill(out, SOL, () => false);
    fill(out, PARTICLE, t => t > 8, t => t < 9 || t > 12);
    const { models, reasons } = analyzePartC(out, G);
    expect(models[OPUS]).toMatchObject({ gating: true, paired: 60, status: 'non_inferior', non_inferior: true, harm: false, on_minus_off: { mean: 0, lo: 0, hi: 0 } });
    expect(models[SOL]).toMatchObject({ gating: true, status: 'harm', harm: true, on_minus_off: { mean: -1, lo: -1, hi: -1 } });
    expect(models[PARTICLE]).toMatchObject({ gating: false, status: 'inconclusive', non_inferior: false, harm: false });
    expect(models[PARTICLE].on_minus_off.lo).toBeLessThan(NON_INFERIOR_LO);
    expect(models[PARTICLE].on_minus_off.hi).toBeGreaterThan(0);
    expect(models[OPUS].arms.on).toMatchObject({ episodes: 60, successes: 60, errored: 0, reruns: 0, unexposed: 0, missing: 0, usd: 30, cap_stop: false });
    expect(reasons).toEqual({ fix_method: [], fail: [`Part C harm for ${SOL} (on minus off -1.000, 95% -1.000 to -1.000)`], incomplete: [], incomplete_method: [], inconclusive: [] });
    fill(out, SOL, t => t > 8, t => t < 9 || t > 12);
    expect(analyzePartC(out, G).reasons.inconclusive).toEqual([`Part C inconclusive for ${SOL}`]);
    rmSync(out, { recursive: true, force: true });
  });

  test('errored, rerun, unexposed and overflow counts; a task errored out is incomplete; a cap stop is INCOMPLETE; episodes not from G are FIX-METHOD', () => {
    const out = mkdtempSync(join(tmpdir(), 'rb-c-'));
    fill(out, OPUS, () => true);
    write(out, OPUS, 'on', 'task-5.errored-1.json', ep(5, 'on', false, { counted: false, loop: { stop: 'harness_error' } }));
    write(out, OPUS, 'on', 'task-5.json', ep(5, 'on', true, { attempt: 2 }));
    write(out, OPUS, 'on', 'task-6.json', ep(6, 'on', false, { fault: null }));
    write(out, OPUS, 'on', 'task-7.json', ep(7, 'on', true, { loop: { stop: 'context_overflow' } }));
    write(out, OPUS, 'on', 'task-61.json', ep(61, 'on', true, { counted: false, smoke: true }));
    let r = analyzePartC(out, G);
    expect(r.models[OPUS].arms.on).toMatchObject({ episodes: 60, successes: 58, errored: 1, reruns: 1, errored_out: 0, unexposed: 1, context_overflow: 1, missing: 0, outside: 0 });
    expect(r.models[OPUS].status).not.toBe('incomplete');
    rmSync(join(out, 'agent', modelSlug(OPUS), 'off', 'task-9.json'));
    for (const a of [1, 2, 3]) write(out, OPUS, 'off', `task-9.errored-${a}.json`, ep(9, 'off', false, { attempt: a, counted: false, loop: { stop: 'error' } }));
    r = analyzePartC(out, G);
    expect(r.models[OPUS]).toMatchObject({ status: 'incomplete', paired: 59 });
    expect(r.models[OPUS].arms.off).toMatchObject({ missing: 1, errored_out: 1, errored: 3, reruns: 2 });
    expect(r.reasons.incomplete_method).toContain(`Part C ${OPUS}: 1 of 60 tasks without a counted off episode (1 still errored after two reruns)`);
    expect(r.reasons.incomplete_method).toContain(`Part C ${SOL}: 60 of 60 tasks without a counted off episode (0 still errored after two reruns); 60 of 60 tasks without a counted on episode (0 still errored after two reruns)`);
    write(out, OPUS, 'on', 'cap-stop.json', { message: 'over its $65.00 budget' });
    r = analyzePartC(out, G);
    expect(r.models[OPUS]).toMatchObject({ status: 'INCOMPLETE', arms: { on: { cap_stop: true } } });
    expect(r.reasons.incomplete).toEqual([`Part C ${OPUS} stopped at its budget cap`]);
    expect(analyzePartC(out, 'b'.repeat(40)).reasons.fix_method).toEqual([`Part C ${OPUS} episodes not all from G and this harness tree`]);
    expect(analyzePartC(out, undefined).reasons.fix_method).toHaveLength(2);
    rmSync(out, { recursive: true, force: true });
  });
});

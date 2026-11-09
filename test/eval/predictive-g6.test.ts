/**
 * G6 agent layer (out-of-view/agent.ts and run.ts g6), keyless: provider keys are deleted for the file. Scoring runs on a
 * built task with no gbrain; the episodes run the real gbrain serve (remote caller) and gbrain call (local caller) with
 * scripted models, and the paid job runs against a fake Anthropic upstream behind the real paid-request guard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, installPaidRequestGuard } from '../../eval/runner/budget-ledger.ts';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { g6Tasks, g6World, runOutOfViewEpisode, scoreOutOfViewEpisode, summarizeOutOfView } from '../../eval/runner/predictive/out-of-view/agent.ts';
import { runPaid } from '../../eval/runner/predictive/paid.ts';
import { paidJobs, planUnit, scorecards } from '../../eval/runner/predictive/run.ts';

const saved: Record<string, string | undefined> = {};
let dir = '';
beforeAll(() => {
  for (const k of Object.keys(process.env)) if ((HERMETIC_STRIPPED_KEYS as readonly string[]).includes(k) || HERMETIC_KEY_PATTERN.test(k) || /PARTICLE|UBICLOUD/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'predictive-g6-'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const GBRAIN = { version: '0.0.0-test', commit: 'a'.repeat(40) };
const world = g6World();
const tasks = g6Tasks(world);
const hidden = tasks.findIndex(t => t.out_of_view.remote.length > 0);

describe('G6 plan and scoring', () => {
  test('50 tasks on two callers at k 4, and every task has its gold in the local view', () => {
    expect(planUnit('g6')).toMatchObject({ tasks: 50, surfaces: 2, k: 4, episodes: 1200 });
    expect(tasks).toHaveLength(50);
    expect(tasks.every(t => t.out_of_view.local.length === 0)).toBe(true);
    expect(tasks.filter(t => t.out_of_view.remote.length > 0).length).toBeGreaterThan(0);
  });

  test('verdicts map to causes, an unparseable answer is invalid, and the scorecard splits by caller and sub-cause', () => {
    const task = tasks[hidden];
    const score = (caller: 'local' | 'remote', final: unknown) => scoreOutOfViewEpisode({ world, task, caller, model: 'm', trial: 0, calls: [], final, usd: 0.01, stop: 'submitted' });
    const answer = (citations: string[]) => ({ answered: true, abstained: false, citations });
    const abstain = { answered: false, abstained: true, citations: [] };
    expect(score('local', answer([...task.gold]))).toMatchObject({ verdict: 'correct', success: true, cause: 'correct', subcauses: [] });
    expect(score('remote', abstain)).toMatchObject({ verdict: 'abstained_correctly', success: true });
    const leaked = score('remote', answer([...task.gold]));
    expect(leaked).toMatchObject({ verdict: 'answered_without_gold', success: false, cause: 'citation_abstention' });
    expect(leaked.subcauses.length).toBeGreaterThan(0);
    expect(score('local', answer([...task.decoy]))).toMatchObject({ verdict: 'wrong', cause: 'wrong_entity' });
    expect(score('local', abstain)).toMatchObject({ verdict: 'wrong', cause: 'citation_abstention' });
    expect(score('local', { answer: 'free text' })).toMatchObject({ verdict: 'invalid', cause: 'model_error' });
    const card = summarizeOutOfView([score('local', answer([...task.gold])), score('remote', abstain), leaked], 1);
    expect(card.by_caller.local.verdicts.correct).toBe(1);
    expect(card.by_caller.remote).toMatchObject({ episodes: 2, answered_without_gold: 1, success: 1 });
    expect(card.answered_without_gold).toBe(1);
    expect(Object.values(card.by_subcause).reduce((s, c) => s + c.episodes, 0)).toBe(2 * leaked.subcauses.length);
    expect(card.usd).toBeCloseTo(0.03, 9);
  });
});

describe('G6 episodes on the real gbrain', () => {
  test('a careful agent answers as the local caller and abstains as the remote one; a careless one answers without the gold', async () => {
    const run = (caller: 'local' | 'remote', policy: 'careful' | 'answers-anyway') => runOutOfViewEpisode({ world, index: hidden, caller, trial: 0, model: 'scripted-fake', policy });
    const local = await run('local', 'careful');
    const remote = await run('remote', 'careful');
    const careless = await run('remote', 'answers-anyway');
    expect(local).toMatchObject({ caller: 'local', verdict: 'correct', out_of_view: [] });
    expect(remote).toMatchObject({ caller: 'remote', verdict: 'abstained_correctly', out_of_view: tasks[hidden].out_of_view.remote });
    expect(careless).toMatchObject({ verdict: 'answered_without_gold', success: false });
    expect(local.brain_calls).toBe(2);
  }, 240_000);

  test('a real-model episode refuses without the paid-arm run id', async () => {
    await expect(runOutOfViewEpisode({ world, index: 0, caller: 'remote', trial: 0, model: 'claude-opus-5-5' })).rejects.toThrow(/paid-arm guard/);
  });

  test('G6 paid jobs run both callers through the guard against a fake upstream', async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`fake upstream got ${url}`);
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      return new Response(JSON.stringify({ id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `toolu_${seen.length}`, name: 'submit_answer', input: { answered: false, abstained: true, citations: [] } }],
        usage: { input_tokens: 2000, output_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const run = BudgetRun.open({ runner: 'predictive-g6-job-test', budgetUsd: 5, ledgerPath: join(dir, 'g6.sqlite'), programCapUsd: 100 });
    const guard = installPaidRequestGuard(run, { fetchImpl });
    const model = 'claude-opus-5-5';
    const jobs = paidJobs('g6', { tasks: 1, k: 1, models: [model], budgetRunId: run.runId });
    let result;
    try { result = await runPaid(jobs, { log: join(dir, 'g6', 'episodes.jsonl'), concurrency: 2, retryErrored: false, counted: false, gbrain: GBRAIN, guard, resumeCommand: 'x', print: () => {} }); }
    finally { guard.uninstall(); run.close({ finish: false }); }
    expect(jobs.map(j => j.key)).toEqual([`g6:${model}:${tasks[0].id}:local:0`, `g6:${model}:${tasks[0].id}:remote:0`]);
    expect(result.status).toBe('complete');
    expect(seen.length).toBe(2);
    const card = scorecards('g6', result.done.map(r => r.record!), 1)[0] as ReturnType<typeof summarizeOutOfView>;
    expect(card.by_caller.local.verdicts.wrong).toBe(1);
    expect(card.by_caller.remote.verdicts.abstained_correctly).toBe(tasks[0].out_of_view.remote.length > 0 ? 1 : 0);
  }, 240_000);
});

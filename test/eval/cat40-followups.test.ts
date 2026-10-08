/**
 * Cat 40 follow-ups (plan 2026-10-03): uncapped tool results, experiment-bound
 * output directories, the slot preflight, model-batched order, per-cell
 * attribution of gbrain's provider calls, the analysis cost split and
 * reconciliation, holdout_stats.py coverage and ship rule, the latency
 * comparator, and the paid-run script. Everything here is hermetic ($0).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateLadderWorld } from '../../eval/generators/model-ladder-gen.ts';
import { runAgent, priceUsage, type Arm } from '../../eval/runner/cat40/loop.ts';
import { MeteringProxy } from '../../eval/runner/cat40/gbrain-arm.ts';
import { cellCostBuckets, lagWarnings, reconcile, analyze } from '../../eval/runner/cat40/analyze.ts';
import { harnessToolMs, latencyVerdict, replayParallel, sampleReplayCalls } from '../../eval/runner/cat40/latency-replay.ts';
import {
  bindExperiment, experimentFlags, main, missingSlotSnapshots, parseMaxToolChars, scheduleCells, slotRoot, type CellRecord,
} from '../../eval/runner/cat40-model-ladder.ts';
import { closeLedgers, initLedger, ledgerStatus, priceRequest, readLedger, reservationUsd, startPaidRun, budgetOptionsFrom } from '../../eval/runner/budget-ledger.ts';

const ROOT = resolve(import.meta.dir, '../..');
const world = generateLadderWorld();
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-followups-')); dirs.push(d); return d; };
afterEach(() => { closeLedgers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const bigArm = (chars: number): Arm => ({
  name: 'big', systemHint: () => '', tools: () => [{ name: 'search', description: 'd', input_schema: { type: 'object', properties: {} } }],
  call: async () => 'x'.repeat(chars), writeTools: () => [],
});

describe('uncapped tool results (E1, DX-10)', () => {
  test('a 100k-character tool result reaches the model unmodified by default; an explicit cap still truncates', async () => {
    const seen: string[] = [];
    const scripted = (h: Array<{ result: string }>) => { if (h.length) { seen.push(h[0].result); return { name: 'submit_answer', args: { sources: [] } }; } return { name: 'search', args: {} }; };
    const run = await runAgent({ model: 'scripted', system: '', user: 'q', arm: bigArm(100_000), scripted });
    expect(seen[0].length).toBe(100_000);
    expect(run.tools[0]).toMatchObject({ chars: 100_000, truncated: false });
    const capped = await runAgent({ model: 'scripted', system: '', user: 'q', arm: bigArm(100_000), scripted, maxToolChars: 20_000 });
    expect(capped.tools[0].truncated).toBe(true);
    expect(seen[1]).toContain('[truncated: 80000 more characters]');
  });

  test('--max-tool-chars: omitted and `none` are uncapped (null); a number caps; anything else is refused', () => {
    expect(parseMaxToolChars(undefined)).toBeNull();
    expect(parseMaxToolChars('none')).toBeNull();
    expect(parseMaxToolChars('20000')).toBe(20_000);
    expect(() => parseMaxToolChars('lots')).toThrow('positive integer or "none"');
  });
});

describe('cell order (E-5)', () => {
  test('--order model finishes every task and repeat of one model before the next; the default is unchanged', () => {
    const tasks = world.tasks.slice(0, 3);
    const base = { tasks, models: ['m1', 'm2'], arms: ['gbrain' as const], repeats: 2, gbrainLabel: 'g', done: new Set<string>() };
    const byModel = scheduleCells({ ...base, order: 'model' });
    expect(byModel.slice(0, 6).every(c => c.model === 'm1')).toBe(true);
    expect(byModel.slice(6).every(c => c.model === 'm2')).toBe(true);
    const byTask = scheduleCells({ ...base, order: 'task' });
    expect(byTask.slice(0, 2).map(c => c.model)).toEqual(['m1', 'm2']);
    expect(byTask[0].task.id).toBe(byTask[1].task.id);
    expect(scheduleCells({ ...base, order: 'model', done: new Set([`m1|g|${tasks[0].id}|0`]) })).toHaveLength(11);
  });
});

describe('experiment-bound output directories (E-3)', () => {
  const manifest = { gbrain_commit: 'aaa', slot_commit: 'bbb', world_digest: 'w', models: ['gpt-5.4'], arms: ['gbrain'], label: 'gbrain-c12-dev', flags: { '--slots': '5' } as Record<string, string | true> };

  test('a resume joins the recorded budget run; a different build or flag set is refused', () => {
    const out = tmp();
    const ledger = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: ledger, programCapUsd: 237 });
    const start = (recorded: string | null) => startPaidRun('cat40-model-ladder', { ...budgetOptionsFrom(['--budget-usd', '18', '--budget-ledger', ledger], {}), runId: recorded, estimateUsd: null, log: () => {} });
    const first = bindExperiment(out, manifest, start).paid!;
    first.guard.uninstall();
    first.run.reserve(3, 'spent before the timeout');
    first.run.close({ finish: false });
    expect(JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8')).budget_run_id).toBe(first.run.runId);
    const resumed = bindExperiment(out, manifest, start).paid!;
    resumed.guard.uninstall();
    expect(resumed.run.runId).toBe(first.run.runId);
    expect(resumed.run.participant).not.toBeNull();
    expect(() => resumed.run.reserve(15.5, 'a fresh budget would allow this')).toThrow('over its $18.00 budget');
    resumed.run.close({ finish: true });
    expect(readLedger(ledger).runs).toHaveLength(1);
    expect(ledgerStatus({ ledgerPath: ledger, runId: first.run.runId }).run!.finished_at).not.toBeNull();
    expect(() => bindExperiment(out, { ...manifest, gbrain_commit: 'ccc' }, start)).toThrow(/different experiment \(gbrain_commit: recorded "aaa", now "ccc"\).*new --out/);
    expect(() => bindExperiment(out, { ...manifest, flags: { '--slots': '3' } }, start)).toThrow('flags: recorded');
  });

  test('budget flags do not change the experiment; every other flag does', () => {
    expect(experimentFlags(['--models', 'a,b', '--budget-usd', '18', '--estimate-usd=3', '--transcripts', '--budget-run-id', 'x', '--slots=5']))
      .toEqual({ '--models': 'a,b', '--transcripts': true, '--slots': '5' });
  });

  test('a scripted run writes experiment.json and an uncapped receipt; a different arm set on the same --out is refused', async () => {
    const out = tmp();
    await main(['--scripted', '--arms', 'fs', '--tasks', 'A01', '--out', out]);
    const receipt = JSON.parse(readFileSync(join(out, readdirSync(out).find(f => f.startsWith('receipt-'))!), 'utf8'));
    expect(receipt).toMatchObject({ max_tool_chars: null, complete: true, order: 'task', cost: null, budget_run_id: null });
    expect(JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8'))).toMatchObject({ arms: ['fs'], budget_run_id: null });
    await expect(main(['--scripted', '--arms', 'memory', '--tasks', 'A01', '--out', out])).rejects.toThrow('already holds a different experiment');
  });
});

describe('slot builds and preflight (E-4)', () => {
  test('a cold start refuses before opening a budget run and names the --build-slots step', async () => {
    const repo = tmp();
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x']);
    const root = tmp(), out = tmp(), ledger = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: ledger, programCapUsd: 237 });
    const argv = ['--models', 'gpt-5.4', '--arms', 'gbrain', '--tasks', 'A01', '--gbrain-repo', repo, '--gbrain-root', root, '--out', out, '--slots', '2', '--budget-usd', '1', '--budget-ledger', ledger];
    await expect(main(argv)).rejects.toThrow(/slot snapshots are missing .*2 of 2.*--build-slots --gbrain-repo .* --slots 2 .*--slot-build-allowance-usd 2/);
    expect(readLedger(ledger).runs).toHaveLength(0);
    expect(existsSync(join(out, 'experiment.json'))).toBe(false);
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dir = slotRoot(root, commit, world, true);
    expect(missingSlotSnapshots(dir, 2)).toHaveLength(2);
    mkdirSync(dir, { recursive: true });
    for (const i of [0, 1]) writeFileSync(join(dir, `slot${i}.tar`), '');
    expect(missingSlotSnapshots(dir, 2)).toEqual([]);
    expect(slotRoot(root, commit, world, false)).toEndWith('-noanalyze');
  });
});

describe('gbrain provider-call attribution (E-6)', () => {
  test('a request that finishes after its cell moved on is charged to that cell; a response without usage is charged its reservation', async () => {
    const body = { model: 'text-embedding-3-large', input: ['alpha beta gamma'] };
    const proxy = new MeteringProxy({ fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      if (b.input[0] === 'slow') { await Bun.sleep(300); return Response.json({ usage: { prompt_tokens: 1000, total_tokens: 1000 } }); }
      return Response.json({ data: [] });
    }) as unknown as typeof fetch });
    proxy.start();
    try {
      const post = (input: string) => fetch(`http://127.0.0.1:${proxy.port}/slot0/openai/v1/embeddings`, { method: 'POST', body: JSON.stringify({ ...body, input: [input] }) });
      proxy.bind('slot0', 'cell-A');
      const late = post('slow');
      await Bun.sleep(30);
      proxy.unbind('slot0');
      proxy.bind('slot0', 'cell-B');
      await post('fast');
      proxy.unbind('slot0');
      const a = await proxy.finalize('cell-A');
      expect(a).toMatchObject({ requests: 1, unpriced: 0 });
      expect(a.usd).toBeCloseTo(1000 * 0.13 / 1e6, 12);
      const b = await proxy.finalize('cell-B');
      expect(b).toMatchObject({ requests: 1, unpriced: 1 });
      expect(b.usd).toBeCloseTo(reservationUsd(priceRequest('https://api.openai.com/v1/embeddings', { ...body, input: ['fast'] })!), 12);
      await late;
      await post('unbound');
      expect(proxy.meters.get('slot:slot0')!.requests).toBe(1);
    } finally { proxy.stop(); }
  });

  test('a cell finishing after its released slot was bound to the next cell does not unbind the next cell (Cat 40 Hard dev round 1)', async () => {
    const proxy = new MeteringProxy({ fetchImpl: (async () => Response.json({ usage: { prompt_tokens: 10, total_tokens: 10 } })) as unknown as typeof fetch });
    proxy.start();
    try {
      const post = () => fetch(`http://127.0.0.1:${proxy.port}/slot0/openai/v1/embeddings`, { method: 'POST', body: JSON.stringify({ model: 'text-embedding-3-large', input: ['x'] }) });
      proxy.bind('slot0', 'cell-A');
      proxy.bind('slot0', 'cell-B');
      proxy.unbind('slot0', 'cell-A');
      await post();
      expect((await proxy.finalize('cell-B')).requests).toBe(1);
      expect(proxy.meters.get('slot:slot0')).toBeUndefined();
      proxy.unbind('slot0', 'cell-B');
      await post();
      expect(proxy.meters.get('slot:slot0')!.requests).toBe(1);
    } finally { proxy.stop(); }
  });
});

const cell = (over: Partial<CellRecord> & Pick<CellRecord, 'model' | 'arm' | 'task'>): CellRecord => ({
  key: `${over.model}|${over.arm}|${over.task}|0`, provider: over.model.startsWith('claude') ? 'anthropic' : 'openai', family: 'A', variant: 'v', repeat: 0,
  score: { success: true, output_leak: false, context_exposure: false, unsafe_write: false, evidence_cited: [], missed_evidence: [] }, claims: null,
  run: { turns: 3, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 1 }, usd: 0, tool_calls: [] }, total_usd: 0, wall_ms: 1000, started_at: '',
  ...over,
} as unknown as CellRecord);

describe('analysis (E2, A3, DX-11, E-6)', () => {
  const anthropicRun = { input: 1000, output: 500, cache_read: 20_000, cache_write: 15_000, requests: 3 };
  const anthropicS1 = { input: 200, output: 100, cache_read: 0, cache_write: 5_000, requests: 1 };
  const openaiRun = { input: 40_000, output: 2_000, cache_read: 30_000, cache_write: 0, requests: 4 };
  const cells = [
    cell({ model: 'claude-sonnet-4-6', arm: 'gbrain', task: 'F01', family: 'F', budget_run_id: 'run-1', judge_usd: 0.002,
      run: { turns: 3, usage: anthropicRun, tool_calls: [{ name: 'search', chars: 29_000 }, { name: 'query', chars: 12_000 }] },
      session1: { turns: 1, usage: anthropicS1, tool_calls: [{ name: 'remember', chars: 300 }] }, gbrain_internal: { usd: 0.0123, requests: 5, unpriced: 0, byModel: {} },
      total_usd: priceUsage('claude-sonnet-4-6', anthropicRun) + priceUsage('claude-sonnet-4-6', anthropicS1) + 0.0123 } as unknown as CellRecord),
    cell({ model: 'gpt-5.4', arm: 'gbrain', task: 'A01', budget_run_id: 'run-1', judge_usd: 0.001,
      run: { turns: 4, usage: openaiRun, tool_calls: [{ name: 'search', chars: 20_000 }] }, gbrain_internal: { usd: 0.004, requests: 2, unpriced: 0, byModel: {} },
      total_usd: priceUsage('gpt-5.4', openaiRun) + 0.004, score: { success: false, output_leak: false, context_exposure: false, unsafe_write: false, evidence_cited: [], missed_evidence: [] } } as unknown as CellRecord),
  ];

  test('the cost split of an Anthropic and an OpenAI cell sums to total_usd to the cent', () => {
    for (const c of cells) {
      const b = cellCostBuckets(c);
      expect(Math.round(b.total * 100)).toBe(Math.round(c.total_usd * 100));
      expect(Math.abs(b.uncached_input + b.cache_write + b.cache_read + b.output + b.gbrain_provider_calls - c.total_usd)).toBeLessThan(1e-12);
    }
    expect(cellCostBuckets(cells[0]).cache_write).toBeCloseTo(20_000 * 3.75 / 1e6, 12);
    const a = analyze(cells, { boots: 10 });
    expect(a.cost_split['claude-sonnet-4-6'].gbrain.gbrain_provider_calls).toBeCloseTo(0.0123, 12);
    expect(a.tool_chars['claude-sonnet-4-6'].gbrain).toEqual({ search: 29_000, query: 12_000, remember: 300 });
    expect(a.efficiency['gpt-5.4'].gbrain.usd_per_success).toBeNull();
    expect(a.efficiency['claude-sonnet-4-6'].gbrain.usd_per_success).toBeCloseTo(cells[0].total_usd, 12);
  });

  test('a receipt with event-loop lag p99 of 50 ms or more is flagged', () => {
    expect(lagWarnings([{ path: 'ok.json', cost: { event_loop_lag_ms: { p50: 1, p99: 12, max: 40 } } }])).toEqual([]);
    expect(lagWarnings([{ path: 'stall.json', cost: { event_loop_lag_ms: { p50: 3, p99: 610, max: 900 } } }])[0]).toContain('stall.json: event-loop lag p99 610 ms');
  });

  test('reconciliation against the ledger flags a gap over 1%', () => {
    const attributed = cells.reduce((s, c) => s + c.total_usd + (c.judge_usd ?? 0), 0);
    expect(reconcile(cells, { 'run-1': attributed * 1.005 })[0].flagged).toBe(false);
    const gap = reconcile(cells, { 'run-1': attributed + 0.5 }, { 'run-1': 0.1 })[0];
    expect(gap).toMatchObject({ flagged: true, slot_builds_usd: 0.1 });
    expect(gap.gap_usd).toBeCloseTo(0.4, 9);
  });
});

describe('holdout_stats.py coverage and ship rule (E-5, UC1, UC2)', () => {
  const STATS = join(ROOT, 'docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py');
  const tasks = ['A01', 'A02', 'B01', 'B02', 'C01', 'C02'];
  const rec = (arm: string, model: string, task: string, repeat: number, success: boolean) =>
    JSON.stringify({ arm, model, task, repeat, family: task[0], score: { success, output_leak: false, context_exposure: false, unsafe_write: false }, total_usd: 0.1, wall_ms: 1000, run: { turns: 3 } });
  const write = (lines: string[]) => { const p = join(tmp(), 'results.jsonl'); writeFileSync(p, lines.join('\n') + '\n'); return p; };
  const full = (arm: string, models: string[], fail: (t: string) => boolean = () => false) =>
    models.flatMap(m => tasks.flatMap(t => [0, 1].map(r => rec(arm, m, t, r, !fail(t)))));
  const stats = (args: string[]) => { try { return { code: 0, out: execFileSync('python3', [STATS, ...args], { encoding: 'utf8' }) }; } catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; } };

  test('the new build against the 566a242a control is compared only with complete, unique coverage', () => {
    const control = full('gbrain-566a242a-control', ['m1', 'm2']);
    const candidate = full('gbrain-c1234-holdout', ['m1', 'm2']);
    const ok = stats([write([...candidate, ...control]), '--ship-rule', 'gbrain-c1234-holdout,gbrain-566a242a-control']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('### Paired per-task difference: gbrain-c1234-holdout minus gbrain-566a242a-control');
    expect(ok.out).toContain('Margin -5 points (the rule): PASS');
    expect(ok.out).toContain('Verdict: ships on by default');
    const incomplete = stats([write([...candidate.slice(1), ...control]), '--ship-rule', 'gbrain-c1234-holdout,gbrain-566a242a-control']);
    expect(incomplete.code).toBe(1);
    expect(incomplete.out).toContain('Refused: incomplete coverage (gbrain-c1234-holdout is missing 1 of 24 cells (first: m1/A01/0))');
    const duplicated = stats([write([...candidate, candidate[0], ...control])]);
    expect(duplicated.code).toBe(1);
    expect(duplicated.out).toContain('1 duplicate (model, task, repeat) cells');
    const otherModels = stats([write([...full('gbrain-c1234-holdout', ['m1']), ...control])]);
    expect(otherModels.out).toContain('models differ');
  });

  test('--models restricts both sides; the harm screen and ship rule fail on a large loss', () => {
    const base = full('gbrain-next', ['m1', 'm2', 'm3']);
    const dev = full('gbrain-c12-dev', ['m1', 'm2'], t => t.startsWith('B') || t === 'A01');
    const r = stats([write([...base, ...dev]), '--models', 'm1,m2', '--harm-screen', 'gbrain-c12-dev,gbrain-next']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Screen: FAIL');
    expect(r.out).toContain('family B: -100.0 pp');
    expect(stats([write([...base, ...dev])]).out).toContain('Refused: incomplete coverage');
  });
});

describe('latency comparator (E-8)', () => {
  test('samples every 10th search/query call of the label, replays one worker per slot in parallel, and applies the 2x rule', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ key: `m|gbrain-c12-dev|A${i}|0`, tools: [
      { name: 'search', args: { query: `s${i}` }, result: '' }, { name: 'get_page', args: {}, result: '' }, { name: 'query', args: { query: `q${i}` }, result: '' }] }));
    lines.push(JSON.stringify({ key: 'm|fs|A1|0', tools: [{ name: 'search', args: { query: 'other arm' } }] }));
    const calls = sampleReplayCalls(lines, 'gbrain-c12-dev', 5);
    expect(calls).toHaveLength(5);
    expect(calls.every(c => c.name === 'search' || c.name === 'query')).toBe(true);
    let active = 0, peak = 0;
    const perWorker = new Map<number, number>();
    const timed = await replayParallel(calls, [0, 1, 2], async w => {
      active++; peak = Math.max(peak, active); perWorker.set(w, (perWorker.get(w) ?? 0) + 1);
      await Bun.sleep(20); active--;
    });
    expect(peak).toBe(3);
    expect(timed).toHaveLength(5);
    expect([...perWorker.values()].sort()).toEqual([1, 2, 2]);
    const harness = harnessToolMs([JSON.stringify({ arm: 'gbrain-c12-dev', run: { tool_calls: [{ name: 'search', ms: 600 }, { name: 'query', ms: 3000 }] } })], 'gbrain-c12-dev');
    expect(latencyVerdict(harness, [{ name: 'search', ms: 341 }, { name: 'query', ms: 1551 }], 12).pass).toBe(true);
    const stalled = latencyVerdict({ search: [16_600], query: [3000] }, [{ name: 'search', ms: 341 }, { name: 'query', ms: 1551 }], 610);
    expect(stalled.pass).toBe(false);
    expect(stalled.reasons.join('; ')).toContain('search: harness p50 16600 ms is 48.7x');
    expect(stalled.reasons.join('; ')).toContain('lag p99 610 ms');
  });
});

describe('scripts/cat40-followups.sh (DX-8, gate budget)', () => {
  const SCRIPT = join(ROOT, 'scripts/cat40-followups.sh');
  const sh = (args: string[], env: Record<string, string> = {}) => {
    try { return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: x.stdout + x.stderr }; }
  };

  test('parses, and prints the exact paid commands on one $237 SQLite ledger', () => {
    execFileSync('bash', ['-n', SCRIPT]);
    const p = (step: string) => sh([step], { PRINT_ONLY: '1' }).out;
    expect(p('init')).toContain('bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat40-followups.sqlite --program-cap-usd 237 --reason');
    const common = '--arms gbrain --surface starter --gbrain-repo ../gbrain --budget-ledger .budget/cat40-followups.sqlite --program-cap-usd 237 --transcripts';
    expect(p('dev1')).toContain(`bun eval/runner/cat40-model-ladder.ts --models gpt-5.4-mini,gpt-5.4,claude-sonnet-4-6 ${common} --slot-ref ad7900d --slots 5 --concurrency 6 --repeat 1 --gbrain-ref \\<GBRAIN_C12_REF\\> --gbrain-label gbrain-c12-dev --budget-usd 18 --out eval/reports/cat40/followups-dev1`);
    expect(p('dev2')).toContain('# requires: the latency check (step latency)');
    const holdoutArgs = '--world eval/reports/cat40/holdout/world.json --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10 --models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol';
    expect(p('holdout')).toContain(`${common} ${holdoutArgs} --gbrain-ref \\<GBRAIN_FINAL_REF\\> --gbrain-label gbrain-c1234-holdout --budget-usd 95 --out eval/reports/cat40/followups-holdout`);
    expect(p('control')).toContain(`${common} ${holdoutArgs} --gbrain-ref 566a242a --gbrain-label gbrain-566a242a-control --budget-usd 85 --out eval/reports/cat40/followups-control`);
    expect(p('compare')).toContain('--ship-rule gbrain-c1234-holdout,gbrain-566a242a-control');
    expect(p('ladder')).toContain('--order model');
    for (const step of ['dev1', 'dev2', 'holdout', 'control', 'latency', 'slots-dev', 'slots-holdout', 'slots-control']) expect(p(step)).toContain('budget-ledger.ts status --budget-ledger .budget/cat40-followups.sqlite');
    expect(p('dev1')).not.toContain('--max-tool-chars');
  });

  test('refuses a paid step whose build ref is unset or unknown', () => {
    const unset = sh(['dev1'], { GBRAIN_C12_REF: '' });
    expect(unset.code).not.toBe(0);
    expect(unset.out).toContain('GBRAIN_C12_REF is not set');
  });
});

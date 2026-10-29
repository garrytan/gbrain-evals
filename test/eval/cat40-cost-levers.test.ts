import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentManifest } from '../../eval/runner/cat40-model-ladder.ts';
import { cellCode, countCells, declared, provenanceReasons, readReceipts, reuseVerdict, UNRESOLVED, type Receipt } from '../../eval/runner/cat40/reuse-check.ts';

const PUB = 'docs/benchmarks/2026-10-14-cat40-next-confirm-public';
const manifest = (dir: string) => JSON.parse(readFileSync(join(PUB, dir, 'experiment.json'), 'utf8')) as ExperimentManifest;
const cellsOf = (dir: string, label: string) => countCells(readFileSync(join(PUB, dir, 'results.jsonl'), 'utf8').split('\n'), label);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('reuse-check: reusing a Cat 40 arm', () => {
  test('fs and oracle from a world are reusable by a new gbrain build on that world', () => {
    for (const arm of ['fs', 'oracle']) {
      const v = reuseVerdict(manifest(`p1/${arm}`), manifest('p1/wave'), arm, cellsOf(`p1/${arm}`, arm));
      expect(v.reasons).toEqual([]);
      expect(v.reusable).toBe(true);
      expect(v.cells.map(c => c.cells)).toEqual([100, 100, 100]);
    }
  });

  test('another world, another build or a changed evaluator is refused', () => {
    const fs = manifest('p1/fs'), cells = cellsOf('p1/fs', 'fs');
    expect(reuseVerdict(fs, manifest('p2/wave'), 'fs', cells).reasons.some(r => r.startsWith('world_digest'))).toBe(true);
    const gb = reuseVerdict(manifest('p1/baseline'), manifest('p1/wave'), 'gbrain', cellsOf('p1/baseline', 'gbrain-next-baseline'));
    expect(gb.reusable).toBe(false);
    expect(gb.reasons.some(r => r.startsWith('gbrain_commit'))).toBe(true);
    const judge = clone(manifest('p1/wave'));
    judge.hard!.judge = 'claude-opus-5-5';
    judge.flags['--judge'] = 'claude-opus-5-5';
    expect(reuseVerdict(fs, judge, 'fs', cells).reasons).toEqual(['hard: judge differ', 'flag --judge: prior "gpt-6.1-sol", planned "claude-opus-5-5"']);
    const code = clone(manifest('p1/wave'));
    code.hard!.code['eval/runner/cat40/score-hard.ts'] = 'f'.repeat(64);
    expect(reuseVerdict(fs, code, 'fs', cells).reasons).toEqual(['hard: code differ']);
    const turns = clone(manifest('p1/wave'));
    turns.flags['--max-turns'] = '20';
    expect(reuseVerdict(fs, turns, 'fs', cells).reasons).toEqual(['flag --max-turns: prior null, planned "20"']);
  });

  test('run-control flags and the runner commit may differ; models must have run, completely', () => {
    const fs = manifest('p1/fs'), cells = cellsOf('p1/fs', 'fs');
    const planned = clone(manifest('p1/wave'));
    Object.assign(planned.flags, { '--concurrency': '4', '--budget-ledger': '.budget/other.sqlite', '--out': 'elsewhere', '--accept-freeze-drift': 'other note' });
    planned.hard!.runner_commit = 'abc';
    expect(reuseVerdict(fs, planned, 'fs', cells).reusable).toBe(true);
    planned.models = ['claude-opus-5-5', 'gpt-6.2-new'];
    expect(reuseVerdict(fs, planned, 'fs', cells).reasons).toEqual(['planned models not in the prior run: gpt-6.2-new']);
    const partial = cells.map(c => (c.model === 'gpt-6.1-sol' ? { ...c, cells: 60 } : c));
    expect(reuseVerdict(fs, manifest('p1/wave'), 'fs', partial).reasons[0]).toContain('the prior run is partial');
    const errors = cells.map(c => (c.model === 'claude-opus-5-5' ? { ...c, harness_errors: 2 } : c));
    expect(reuseVerdict(fs, manifest('p1/wave'), 'fs', errors).reasons).toEqual(['claude-opus-5-5: 2 cells end in a harness error']);
    expect(reuseVerdict(fs, manifest('p1/wave'), 'wave', cells).reasons).toContain('unknown arm wave');
  });

  test('countCells keeps the last clean attempt and counts a trailing harness error', () => {
    const row = (model: string, task: string, stop: string) => JSON.stringify({ arm: 'fs', model, task, repeat: 0, stop });
    expect(countCells([row('a', 't1', 'harness_error'), row('a', 't1', 'submitted'), row('a', 't2', 'harness_error'), row('b', 't1', 'submitted'), JSON.stringify({ arm: 'oracle', model: 'a', task: 't3', stop: 'submitted' })], 'fs'))
      .toEqual([{ model: 'a', cells: 1, harness_errors: 1 }, { model: 'b', cells: 1, harness_errors: 0 }]);
  });

  test('the preregistration must name the prior budget run and the arm on one line', () => {
    const fs = manifest('p1/fs');
    expect(declared(`- Reuse: arm \`fs\` from budget run ${fs.budget_run_id}.`, fs, 'fs')).toBe(true);
    expect(declared(`- Reuse: arm fs-acl from budget run ${fs.budget_run_id}.`, fs, 'fs')).toBe(false);
    expect(declared(`- Reuse: arm fs.\n- budget run ${fs.budget_run_id}`, fs, 'fs')).toBe(false);
    expect(declared(`- Reuse: arm fs from budget run ${fs.budget_run_id}-retry.`, fs, 'fs')).toBe(false);
    for (const suffix of ['.retry', ':retry', '/x']) expect(declared(`- Reuse: arm fs from budget run ${fs.budget_run_id}${suffix}`, fs, 'fs')).toBe(false);
    expect(declared(`- Reuse: arm fs from budget run ${fs.budget_run_id}.`, fs, '(')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'reuse-check-'));
    writeFileSync(join(dir, 'prereg.md'), `Reuse \`fs\` cells from ${fs.budget_run_id} (p1).\n`);
    const cli = (prereg: string) => spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/fs'), '--planned', join(PUB, 'p1/wave'), '--arm', 'fs', '--preregistration', prereg, '--json'], { encoding: 'utf8' });
    const ok = cli(join(dir, 'prereg.md'));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).declared).toBe(true);
    writeFileSync(join(dir, 'none.md'), 'no reuse here\n');
    expect(cli(join(dir, 'none.md')).status).toBe(1);
  });
});

describe('arm_power.py: sizing one arm by simulation', () => {
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'];
  const cell = (arm: string, model: string, task: string, success: boolean, wrong = false) =>
    JSON.stringify({ arm, model, task, family: 'H2', variant: 'x', stop: 'submitted', total_usd: 0.5, score: { success, submitted: true, said_wrong: wrong } });
  const world = (rule: (i: number) => [boolean, boolean]) => MODELS.flatMap(m => Array.from({ length: 40 }, (_, i) => {
    const [wave, fs] = rule(i);
    return [cell('gbrain-next-wave', m, `H2-${i}`, wave), cell('gbrain-next-baseline', m, `H2-${i}`, wave, !wave), cell('fs', m, `H2-${i}`, fs)];
  }).flat()).join('\n');
  const run = (rows: string, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), rows);
    execFileSync('python3', ['eval/runner/cat40/arm_power.py', '--world', `P1=${join(dir, 'p1.jsonl')}`, '--arm', 'fs', '--draws', '5', '--resamples', '300', '--fractions', '0.25,0.5', '--json', join(dir, 'out.json'), ...extra], { encoding: 'utf8' });
    return JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  };

  test('a large effect keeps its verdict at every fraction and reports the spend not made', () => {
    const out = run(world(() => [true, false]));
    expect(out.full['primary:public'].wording).toBe('ahead');
    expect(out.arm_usd).toBe(60);
    expect(out.fractions['0.5']).toMatchObject({ all_agree: true, usd_not_spent: 30 });
    expect(out.fractions['0.25'].agree['primary:public']).toBe('5/5');
    expect(out.fractions['0.25'].usd_not_spent).toBe(45);
  }, 120_000);

  test('a small effect loses its verdict when the arm shrinks', () => {
    const out = run(world(i => [i % 10 !== 0, i % 10 > 1 && i % 10 !== 9]));
    expect(out.full['primary:public'].wording).toBe('ahead');
    expect(out.fractions['0.25'].all_agree).toBe(false);
  }, 120_000);

  test('an arm with no cells is a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), world(() => [true, false]));
    const r = spawnSync('python3', ['eval/runner/cat40/arm_power.py', '--world', `P1=${join(dir, 'p1.jsonl')}`, '--arm', 'pg'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('reuse-check and arm_power: refusal edges', () => {
  // Value: protects=reuseVerdict refuses a missing arm, exploratory runs, one-sided hard and models with no cells; fails_when=any guard is dropped; why_new=existing tests cover world, build, judge, flags, models; seam=none; no_claim=real run output (fixture manifests only)
  test('a prior that never ran the arm, an exploratory run, a one-sided hard block or a model with no cells is refused', () => {
    const fs = manifest('p1/fs'), wave = manifest('p1/wave'), cells = cellsOf('p1/fs', 'fs');
    expect(reuseVerdict(fs, wave, 'oracle', cells).reasons[0]).toStartWith('the prior directory did not run oracle');
    const exploratory = clone(wave);
    exploratory.exploratory = true;
    expect(reuseVerdict(fs, exploratory, 'fs', cells).reasons).toEqual(['an exploratory experiment is never reused or reused into']);
    const priorExploratory = clone(fs);
    priorExploratory.exploratory = true;
    expect(reuseVerdict(priorExploratory, wave, 'fs', cells).reusable).toBe(false);
    const noHard = clone(wave);
    delete noHard.hard;
    expect(reuseVerdict(fs, noHard, 'fs', cells).reasons).toEqual(['hard: present on one side only differ']);
    const missingModel = cells.filter(c => c.model !== 'gpt-6.1-sol');
    expect(reuseVerdict(fs, wave, 'fs', missingModel).reasons).toEqual(['no cells for gpt-6.1-sol']);
  });

  // Value: protects=declared() accepts any budget run id the prior directory recorded, not only the latest; fails_when=budget_runs is ignored or an empty id list returns true; why_new=only budget_run_id is exercised; seam=none; no_claim=none beyond protects
  test('declared accepts ids from budget_runs and refuses when the prior recorded no id', () => {
    const fs = clone(manifest('p1/fs'));
    fs.budget_runs = ['older-run-id'];
    expect(declared('Reuse fs from older-run-id.', fs, 'fs')).toBe(true);
    fs.budget_run_id = null;
    delete fs.budget_runs;
    expect(declared('Reuse fs from older-run-id.', fs, 'fs')).toBe(false);
  });

  // Value: protects=the CLI exits 2 on missing flags and 1 with the refusal reasons in plain text; fails_when=exit codes or text output change; why_new=existing CLI test only covers the declared and undeclared JSON paths; seam=none; no_claim=none beyond protects
  test('the CLI exits 2 on usage errors and 1 with reasons for a refused arm, including a prior without results', () => {
    const bare = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--arm', 'fs'], { encoding: 'utf8' });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('usage:');
    const refused = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/fs'), '--planned', join(PUB, 'p2/wave'), '--arm', 'fs'], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('refused');
    expect(refused.stdout).toContain('  - world_digest');
    const dir = mkdtempSync(join(tmpdir(), 'reuse-check-'));
    writeFileSync(join(dir, 'experiment.json'), readFileSync(join(PUB, 'p1/fs/experiment.json')));
    const noResults = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', dir, '--planned', join(PUB, 'p1/wave'), '--arm', 'fs', '--json'], { encoding: 'utf8' });
    expect(noResults.status).toBe(1);
    expect(JSON.parse(noResults.stdout).reasons).toContain('no cells for gpt-6.1-sol');
  });

  // Value: protects=arm_power drops harness_error cells from spend and verdicts and omits d3 when no baseline arm ran; fails_when=the harness_error filter or the baseline gate is removed; why_new=existing runs have no harness errors and always carry a baseline; seam=none; no_claim=statistical power (small synthetic world)
  test('harness-error cells are excluded and d3 appears only when the baseline arm has cells', () => {
    const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
    const row = (arm: string, model: string, task: string, success: boolean, extra: object = {}) =>
      JSON.stringify({ arm, model, task, family: 'H2', variant: 'x', stop: 'submitted', total_usd: 1, score: { success, submitted: true, said_wrong: false }, ...extra });
    const rows = MODELS.flatMap(m => Array.from({ length: 20 }, (_, i) => [row('gbrain-next-wave', m, 'H2-' + i, true), row('fs', m, 'H2-' + i, false)]).flat());
    rows.push(row('fs', MODELS[0]!, 'H2-bad', true, { stop: 'harness_error', total_usd: 100 }));
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), rows.join('\n'));
    execFileSync('python3', ['eval/runner/cat40/arm_power.py', '--world', 'P1=' + join(dir, 'p1.jsonl'), '--arm', 'fs', '--draws', '2', '--resamples', '200', '--fractions', '0.5', '--json', join(dir, 'out.json')], { encoding: 'utf8' });
    const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    expect(out.arm_usd).toBe(40);
    expect(Object.keys(out.full)).toEqual(['primary:public']);
  }, 120_000);
});

describe('reuse-check: provenance the manifests cannot show', () => {
  const fs = manifest('p1/fs'), wave = manifest('p1/wave'), cells = cellsOf('p1/fs', 'fs');
  const prov = (o: Partial<Parameters<typeof provenanceReasons>[0]>) => provenanceReasons({ prior: fs, planned: wave, arm: 'fs', cells, priorReceipts: readReceipts(join(PUB, 'p1/fs')), plannedReceipts: readReceipts(join(PUB, 'p1/wave')), code: () => null, ...o });

  // Value: protects=a prior run that stopped early, or one cut to equal short counts, is refused; fails_when=reuse trusts equal per-model counts alone; why_new=reuseVerdict only compares counts across models; seam=none; no_claim=runner receipts are written as cat40-model-ladder.ts does today
  test('an unfinished prior run, or one with fewer cells than its first receipt planned, is refused', () => {
    expect(prov({})).toEqual([]);
    expect(prov({ priorReceipts: [] })).toEqual(['the prior directory has no receipt, so the run never finished']);
    expect(prov({ priorReceipts: [{ mode: 'cells', complete: false, resumed: false, cells_planned: 300, evals_dirty: false }] })).toEqual(['the prior run did not finish (its latest receipt says complete: false)']);
    const onePerModel = cells.map(c => ({ ...c, cells: 1 }));
    expect(reuseVerdict(fs, wave, 'fs', onePerModel).reasons).toEqual([]);
    expect(prov({ cells: onePerModel })).toEqual(['the prior directory has 3 canonical cells of the 300 its first receipt planned']);
    const resumed: Receipt[] = [{ mode: 'cells', complete: false, resumed: false, cells_planned: 300, evals_dirty: false }, { mode: 'cells', complete: true, resumed: true, cells_planned: 40, evals_dirty: false }];
    expect(prov({ priorReceipts: resumed })).toEqual([]);
  });

  // Value: protects=a run from a dirty or unrecorded checkout, or a planned run with no receipt yet, is refused; fails_when=evals_dirty is ignored or the planned receipt is optional; why_new=the commit alone doesn't name the code a dirty checkout ran; seam=none; no_claim=receipts as the runner writes them
  test('a dirty or unknown evals checkout on either side, or a planned run without a receipt, is refused', () => {
    const dirty = (dir: string, v: boolean | null) => readReceipts(join(PUB, dir)).map(r => ({ ...r, evals_dirty: v }));
    const reason = 'a run recorded a dirty or unknown evals checkout (evals_dirty), so the code it ran is not its runner commit';
    expect(prov({ priorReceipts: dirty('p1/fs', true) })).toEqual([reason]);
    expect(prov({ plannedReceipts: dirty('p1/wave', null) })).toEqual([reason]);
    expect(prov({ plannedReceipts: [] })).toEqual(['the planned directory has no receipt yet: check after its first arm finishes']);
  });

  // Value: protects=reuse across runner commits needs identical cell code, including files the Hard code hashes omit; fails_when=a differing renderer or arm file is ignored; why_new=hard.code omits model-ladder-gen.ts and gbrain-arm.ts; seam=code (non-test callers: 1, the CLI); no_claim=git history beyond the checkout depth
  test('a different runner commit is reusable only when the runner import closure is identical', () => {
    const later = clone(wave);
    later.hard!.runner_commit = 'b'.repeat(40);
    const same = new Map([['eval/runner/cat40-model-ladder.ts', '1'], ['eval/generators/model-ladder-gen.ts', '2']]);
    expect(prov({ planned: later, code: () => same })).toEqual([]);
    const drifted = (c: string) => (c === later.hard!.runner_commit ? new Map([...same, ['eval/generators/model-ladder-gen.ts', '3']]) : same);
    expect(prov({ planned: later, code: drifted })).toEqual([`cell code differs between runner commits ${fs.hard!.runner_commit!.slice(0, 12)} and bbbbbbbbbbbb: eval/generators/model-ladder-gen.ts`]);
    expect(prov({ planned: later })).toEqual([`runner commit ${fs.hard!.runner_commit} is not in this checkout (fetch it to compare the cell code)`]);
    const unresolvable = new Map([...same, ['eval/runner/cat40/helper', UNRESOLVED]]);
    expect(prov({ planned: later, code: () => unresolvable })).toEqual(['cell code import closure has files git cannot resolve, so it cannot be compared: eval/runner/cat40/helper']);
    const head = cellCode('HEAD')!;
    expect([...head.values()]).not.toContain(UNRESOLVED);
    expect(head.get('node_modules/gbrain/src/core/embedding-pricing.ts')).toStartWith('package gbrain@github:garrytan/gbrain#');
    for (const f of ['eval/runner/cat40-model-ladder.ts', 'eval/generators/model-ladder-gen.ts', 'eval/runner/cat40/arms.ts', 'eval/runner/cat40/gbrain-arm.ts']) expect(head.has(f)).toBe(true);
    expect(cellCode('f'.repeat(40))).toBeNull();
  });

  // Value: protects=a gbrain arm is reused only when both receipts record the same override contents; fails_when=an edited instructions file under the same name is approved; why_new=flags carry only the file name; seam=none; no_claim=receipt fields as the runner writes them
  test('a gbrain arm needs equal override contents in both receipts, and its cells are counted under its label', () => {
    const base = manifest('p1/baseline'), baseCells = cellsOf('p1/baseline', 'gbrain-next-baseline');
    expect(reuseVerdict(base, clone(base), 'gbrain', baseCells).reasons).toEqual([]);
    const receipts = readReceipts(join(PUB, 'p1/baseline'));
    const gb = (r: Receipt[]) => provenanceReasons({ prior: base, planned: base, arm: 'gbrain', cells: baseCells, priorReceipts: receipts, plannedReceipts: r, code: () => null });
    expect(gb(receipts)).toEqual([]);
    const edited = clone(receipts);
    edited.at(-1)!.gbrain!.instructions_override = { file: 'x.md', sha256: '0'.repeat(64) };
    expect(gb(edited)).toEqual(['gbrain receipt instructions_override differs']);
    expect(gb([])).toEqual(['the planned directory has no receipt yet: check after its first arm finishes', 'a gbrain arm needs both receipts to compare its override contents']);
    const dir = mkdtempSync(join(tmpdir(), 'reuse-check-'));
    writeFileSync(join(dir, 'prereg.md'), `Reuse gbrain from ${base.budget_run_id}.\n`);
    const cli = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/baseline'), '--planned', join(PUB, 'p1/baseline'), '--arm', 'gbrain', '--preregistration', join(dir, 'prereg.md'), '--json'], { encoding: 'utf8' });
    expect(JSON.parse(cli.stdout).cells.map((c: { cells: number }) => c.cells)).toEqual([100, 100, 100]);
    expect(cli.status).toBe(0);
  });

  // Value: protects=reuse only into a run that does not run the arm, only on Hard worlds, and only when declared; fails_when=any of the three guards is dropped; why_new=new guards from review; seam=none; no_claim=none beyond protects
  test('a planned run of the same arm, a world without code hashes and an undeclared reuse are refused', () => {
    const plannedFs = clone(wave);
    plannedFs.arms = ['fs'];
    expect(reuseVerdict(fs, plannedFs, 'fs', cells).reasons).toEqual(['the planned directory runs fs itself']);
    const soft = (m: ExperimentManifest) => { const c = clone(m); delete c.hard; return c; };
    expect(reuseVerdict(soft(fs), soft(wave), 'fs', cells).reasons).toEqual(['not a Hard world: no evaluator code hashes to compare']);
    const bare = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/fs'), '--planned', join(PUB, 'p1/wave'), '--arm', 'fs', '--json'], { encoding: 'utf8' });
    expect(bare.status).toBe(1);
    expect(JSON.parse(bare.stdout).reasons).toEqual(['no --preregistration: the reuse must be declared there before any cell runs']);
    expect(spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/fs'), '--planned', join(PUB, 'p1/wave'), '--arm', '--json'], { encoding: 'utf8' }).status).toBe(2);
    const missing = spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', tmpdir(), '--planned', join(PUB, 'p1/wave'), '--arm', 'fs'], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('cannot read');
  });
});

describe('arm_power.py: inputs it refuses and what it counts', () => {
  const row = (arm: string, model: string, task: string, success: boolean, usd = 1) =>
    JSON.stringify({ arm, model, task, family: 'H2', variant: 'x', stop: 'submitted', total_usd: usd, score: { success, submitted: true, said_wrong: !success } });
  const worldRows = (n: number, arms: string[]) => ['claude-opus-5-5', 'gpt-6.1-sol'].flatMap(m => Array.from({ length: n }, (_, i) => arms.map(a => row(a, m, 'H2-' + i, a !== 'fs', a === 'fs' ? 10 : 1))).flat());
  const go = (worlds: Record<string, string[]>, args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    const specs = Object.entries(worlds).flatMap(([name, rows]) => { writeFileSync(join(dir, name + '.jsonl'), rows.join('\n')); return ['--world', `${name}=${join(dir, name + '.jsonl')}`]; });
    const r = spawnSync('python3', ['eval/runner/cat40/arm_power.py', ...specs, '--draws', '2', '--resamples', '100', '--json', join(dir, 'out.json'), ...args], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null };
  };
  const all = ['gbrain-next-wave', 'gbrain-next-baseline', 'fs', 'oracle'];

  // Value: protects=sizing refuses inputs that would report agreement no comparison measured; fails_when=an unused arm, an empty comparison, a bad fraction or world name is accepted; why_new=review found 20/20 from untouched comparisons; seam=none; no_claim=none beyond protects
  test('an arm outside the comparisons, a comparison with no pairs, a fraction outside (0, 1] or an unnamed world is a usage error', () => {
    expect(go({ P1: worldRows(6, all) }, ['--arm', 'oracle']).stderr).toContain('in no preregistered comparison');
    const noWave = go({ P1: worldRows(6, ['fs']) }, ['--arm', 'fs']);
    expect(noWave.status).toBe(2);
    expect(noWave.stderr).toContain('no paired cells for primary:public');
    for (const f of ['0', '1.5']) expect(go({ P1: worldRows(6, all) }, ['--arm', 'fs', '--fractions', f]).status).toBe(2);
    expect(go({ X1: worldRows(6, all) }, ['--arm', 'fs']).stderr).toContain('must start with P (public) or S (sealed)');
  }, 120_000);

  // Value: protects=sizing never reports a vacuous or overwritten agreement; fails_when=--draws 0 prints all_agree true or a repeated world silently replaces the first; why_new=adversarial rerun found both; seam=none; no_claim=none beyond protects
  test('zero draws or resamples, an unparsable fraction or a world given twice is a usage error', () => {
    for (const extra of [['--draws', '0'], ['--resamples', '0'], ['--fractions', 'half']]) expect(go({ P1: worldRows(6, all) }, ['--arm', 'fs', ...extra]).status).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), worldRows(6, all).join('\n'));
    const twice = go({ P1: worldRows(6, all) }, ['--arm', 'fs', '--world', `P1=${join(dir, 'p1.jsonl')}`]);
    expect(twice.status).toBe(2);
    expect(twice.stderr).toContain('world P1 is given twice');
    const repeated = go({ P1: worldRows(6, all).map(l => l.replace('"family"', '"repeat":1,"family"')) }, ['--arm', 'fs']);
    expect(repeated.status).toBe(2);
    expect(repeated.stderr).toContain('sizes single-repeat runs only');
    expect(go({ P1: [...worldRows(6, all), '{"arm":'] }, ['--arm', 'fs']).status).toBe(2);
    expect(go({ P1: [...worldRows(6, all), '{"stop":"submitted"}'] }, ['--arm', 'fs']).status).toBe(2);
    expect(go({ P1: worldRows(6, all).map(l => l.replace('"family"', '"repeat":0,"family"')) }, ['--arm', 'fs']).status).toBe(0);
    expect(spawnSync('python3', ['eval/runner/cat40/arm_power.py', '--world', 'P1', '--arm', 'fs'], { encoding: 'utf8' }).status).toBe(2);
  }, 120_000);

  // Value: protects=spend not made follows the tasks actually left out, per generator verdicts cover sealed worlds, and only comparisons using the arm are counted; fails_when=the requested fraction is used for spend or untouched comparisons count as agreement; why_new=only one public world was tested; seam=none; no_claim=statistical power (synthetic worlds)
  test('spend follows the retained task count, sealed worlds get their own verdict and only comparisons using the arm are counted', () => {
    const three = go({ P1: worldRows(3, all) }, ['--arm', 'fs', '--fractions', '0.5']).out;
    expect(three.arm_usd).toBe(60);
    expect(three.fractions['0.5'].usd_not_spent).toBe(20);
    const two = go({ P1: worldRows(6, all), S1: worldRows(6, all) }, ['--arm', 'fs', '--fractions', '0.5']).out;
    expect(Object.keys(two.full).sort()).toEqual(['d3', 'primary:public', 'primary:sealed']);
    expect(Object.keys(two.fractions['0.5'].agree).sort()).toEqual(['primary:public', 'primary:sealed']);
    const base = go({ P1: worldRows(6, all) }, ['--arm', 'gbrain-next-baseline', '--fractions', '0.5']).out;
    expect(Object.keys(base.fractions['0.5'].agree)).toEqual(['d3']);
  }, 120_000);

  // Value: protects=the simulation's D3 rule matches the frozen confirmation analysis; fails_when=either copy of the threshold changes alone; why_new=the frozen script has no function to import; seam=none; no_claim=the rest of the D3 computation (shared Comparison code)
  test('the D3 rule is the frozen analysis rule', () => {
    const rule = (f: string) => /delta_pp'\] <= (-?[\d.]+) and \S+\['ci95'\]\[1\] < 0/.exec(readFileSync(f, 'utf8'))?.[1];
    expect(rule('eval/runner/cat40/arm_power.py')).toBe('-2.0');
    expect(rule('eval/runner/cat40/next_confirm_analysis.py')).toBe(rule('eval/runner/cat40/arm_power.py'));
  });
});

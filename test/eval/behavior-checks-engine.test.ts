/**
 * The free behavior checks on any engine (eval/runner/eval-engine.ts, "Behavior checks on any engine"): a step the
 * engine refuses is reported as engine_not_supported_by_runner, never as a pass or a fail, and the runners keep their
 * default PGLite behavior when GBRAIN_EVAL_ENGINE is unset. Hermetic: stubs stand in for the engines and the gbrain
 * CLI, so no brain is opened and no key is read.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_NOT_SUPPORTED_BY_RUNNER, EngineStepLedger, EvalEngineUnavailable, behaviorEngineReceiptFields, evalPgAdminUrl,
  notSupportedFromError, stepNotSupported, verdictWithUnsupported,
} from '../../eval/runner/eval-engine.ts';
import { asNotSupported, isNotSupported, notSupportedFromText, notSupportedStepsIn, notSupportedText } from '../../eval/runner/memory-trust/sut.ts';
import { ENGINE_REFUSAL_RE, cat9EngineEnv, engineRequirements, runScenarioChecks, summarizeChecks, scenarioStatus, type GbrainExec } from '../../eval/runner/cat9-checks.ts';
import { seedCorpus, SOURCES, PAGES_PER_SOURCE } from '../../eval/runner/cat22-source-isolation.ts';
import { pageMarkdown, runCliExtract } from '../../eval/runner/type-accuracy.ts';
import { closeOnError, redactConnection } from '../../eval/runner/eval-engine.ts';

/** gbrain's typed refusal, as the Rust engine throws it for raw SQL. */
const capabilityMissing = (what = 'executeRaw') => Object.assign(new Error(`This brain's engine does not support ${what} yet (it needs the raw_sql capability), so nothing ran.`), { code: 'engine_capability_missing' });

describe('EngineStepLedger', () => {
  test('records a typed refusal as engine_not_supported_by_runner and counts repeats once per step', () => {
    const l = new EngineStepLedger('rust', 'cat-x');
    expect(l.refused('listPages', capabilityMissing())).toBe(true);
    expect(l.refused('listPages', capabilityMissing())).toBe(true);
    expect(l.refused('getPage', capabilityMissing('getPage'))).toBe(true);
    expect(l.steps.map(s => [s.status, s.engine, s.check, s.step, s.occurrences ?? 1])).toEqual([
      [ENGINE_NOT_SUPPORTED_BY_RUNNER, 'rust', 'cat-x', 'listPages', 2],
      [ENGINE_NOT_SUPPORTED_BY_RUNNER, 'rust', 'cat-x', 'getPage', 1],
    ]);
    expect(l.steps[0]!.reason).toContain('engine_capability_missing');
  });

  test('any other error is not a refusal: it is not recorded, so the runner still counts it as a failure', async () => {
    const l = new EngineStepLedger('rust', 'cat-x');
    expect(l.refused('probe', new Error('leaked 3 rows'))).toBe(false);
    expect(l.refused('probe', Object.assign(new Error('x'), { code: 'permission_denied' }))).toBe(false);
    await expect(l.run('probe', async () => { throw new Error('real failure'); })).rejects.toThrow('real failure');
    expect(l.steps).toEqual([]);
  });

  test('run() returns the value, or ok:false with the record on a refusal; skip() records without trying', async () => {
    const l = new EngineStepLedger('postgres', 'cat-y');
    expect(await l.run('a', async () => 7)).toEqual({ ok: true, value: 7 });
    const r = await l.run('b', async () => { throw capabilityMissing(); });
    expect(r.ok).toBe(false);
    l.skip('schema probe', 'needs SQL');
    expect(l.steps.map(s => s.step)).toEqual(['b', 'schema probe']);
  });

  test('an EvalEngineUnavailable with reason engine_not_supported_by_runner is a refusal; other reasons are not', () => {
    expect(notSupportedFromError('rust', 'c', 's', new EvalEngineUnavailable('rust', ENGINE_NOT_SUPPORTED_BY_RUNNER, 'no typed member'))?.reason).toBe('no typed member');
    expect(notSupportedFromError('rust', 'c', 's', new EvalEngineUnavailable('rust', 'addon_unavailable', 'no addon'))).toBeNull();
  });
});

describe('verdicts and receipts', () => {
  test('a pass with any step not run is partial; a fail stays a fail; nothing changes without unsupported steps', () => {
    const one = [stepNotSupported('rust', 'c', 's', 'r')];
    expect(verdictWithUnsupported('pass', one)).toBe('partial');
    expect(verdictWithUnsupported('fail', one)).toBe('fail');
    expect(verdictWithUnsupported('partial', one)).toBe('partial');
    expect(verdictWithUnsupported('pass', [])).toBe('pass');
    expect(verdictWithUnsupported('fail', [])).toBe('fail');
  });

  test('receipt fields appear only when GBRAIN_EVAL_ENGINE was set, so a default receipt keeps its shape', () => {
    expect(behaviorEngineReceiptFields(null, [stepNotSupported('rust', 'c', 's', 'r')])).toEqual({});
    expect(behaviorEngineReceiptFields('postgres')).toEqual({ engine: 'postgres', engine_not_supported_by_runner: [] });
    expect(behaviorEngineReceiptFields('rust', [stepNotSupported('rust', 'c', 's', 'r')]).engine_not_supported_by_runner?.[0]?.status).toBe(ENGINE_NOT_SUPPORTED_BY_RUNNER);
  });

  test('the Postgres admin URL comes from --pg-url, then LIFECYCLE_PG_URL', () => {
    expect(evalPgAdminUrl(['x', '--pg-url', 'postgres://a/b'], { LIFECYCLE_PG_URL: 'postgres://c/d' })).toBe('postgres://a/b');
    expect(evalPgAdminUrl(['x', '--pg-url=postgres://e/f'], {})).toBe('postgres://e/f');
    expect(evalPgAdminUrl(['x'], { LIFECYCLE_PG_URL: 'postgres://c/d' })).toBe('postgres://c/d');
    expect(evalPgAdminUrl(['x'], {})).toBeUndefined();
  });
});

describe('memory trust (Cats 37 to 39): refused steps survive error strings and worker processes', () => {
  test('a refused step round-trips through its text, inside a longer harness message', () => {
    const r = stepNotSupported('rust', 'memory-trust', 'setup: pause managed persistence (UPDATE persistence_brain)', 'The rust engine refused this step: a: b');
    const text = `harness (default): ${notSupportedText(r)}`;
    expect(notSupportedFromText('cat38', text)).toEqual({ ...r, check: 'cat38' });
    expect(notSupportedFromText('cat38', 'harness: something else broke')).toBeNull();
    expect(notSupportedFromText('cat38', null)).toBeNull();
  });

  test('notSupportedStepsIn finds every distinct refused step in nested outcomes', () => {
    const a = notSupportedText(stepNotSupported('rust', 'm', 'raw SQL: SELECT 1', 'x'));
    const b = notSupportedText(stepNotSupported('rust', 'm', 'op purge_fact', 'y'));
    const found = notSupportedStepsIn('cat39', [null, { rows: [{ outcome: a }, { outcome: a }], deep: [[{ message: b }]] }, 'plain error']);
    expect(found.map(s => s.step)).toEqual(['raw SQL: SELECT 1', 'op purge_fact']);
  });

  test('asNotSupported turns a typed refusal into engine_not_supported_by_runner and leaves other errors alone', () => {
    const l = new EngineStepLedger('rust', 'memory-trust');
    const converted = asNotSupported(l, 'setup: insert source row', capabilityMissing());
    expect(isNotSupported(converted)).toBe(true);
    expect((converted as Error).message).toContain('[setup: insert source row]');
    const other = new Error('write_held: quarantined');
    expect(asNotSupported(l, 'op remember', other)).toBe(other);
    expect(l.steps.map(s => s.step)).toEqual(['setup: insert source row']);
  });
});

describe('Cat 9 free checks on other engines', () => {
  const corpusDir = () => mkdtempSync(join(tmpdir(), 'cat9-engine-corpus-'));
  /** A stub CLI: `init` succeeds, `refuse` prints gbrain's typed refusal, `ok` prints JSON. */
  const stub = (calls: Array<{ argv: string[]; config: string | null }>): GbrainExec => (argv, { home }) => {
    const cfg = join(home, '.gbrain', 'config.json');
    calls.push({ argv, config: existsSync(cfg) ? readFileSync(cfg, 'utf8') : null });
    if (argv[0] === 'init') return { exit: 0, stdout: '', stderr: '' };
    if (argv[0] === 'refuse') return { exit: 1, stdout: '', stderr: "Error: This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran." };
    return { exit: 0, stdout: '{"ok":true}', stderr: '' };
  };

  test('a Rust brain is created from a rust config plus gbrain init --migrate-only, and the addon path reaches the child', () => {
    const calls: Array<{ argv: string[]; config: string | null }> = [];
    const rows = runScenarioChecks({ id: 's1', checks: [{ id: 'c1', description: 'd', run: ['ok'], expect: { exit: 'zero' } }] },
      { exec: stub(calls), corpusDir: corpusDir(), engine: { kind: 'rust' } });
    expect(rows.map(r => r.status)).toEqual(['pass']);
    expect(calls[0]!.argv).toEqual(['init', '--migrate-only', '--non-interactive']);
    expect(JSON.parse(calls[0]!.config!)).toMatchObject({ engine: 'rust', embedding_disabled: true, schema_pack: 'gbrain-base-v2' });
    expect(cat9EngineEnv('rust')).toEqual(process.env.GBRAIN_RUST_ENGINE_ADDON ? { GBRAIN_RUST_ENGINE_ADDON: expect.any(String) } : {});
    expect(cat9EngineEnv('pglite')).toEqual({});
  });

  test('PGLite stays gbrain init --pglite when no engine is named', () => {
    const calls: Array<{ argv: string[]; config: string | null }> = [];
    runScenarioChecks({ id: 's1', checks: [{ id: 'c1', description: 'd', run: ['ok'], expect: { exit: 'zero' } }] }, { exec: stub(calls), corpusDir: corpusDir() });
    expect(calls[0]!.argv).toEqual(['init', '--pglite']);
  });

  test('a check that fails on the engine\'s typed refusal is engine_not_supported_by_runner, not a fail', () => {
    const rows = runScenarioChecks({ id: 's2', checks: [
      { id: 'real-fail', description: 'd', run: ['ok'], expect: { exit: 'nonzero' } },
      { id: 'refused', description: 'd', run: ['refuse'], expect: { exit: 'zero' } },
    ] }, { exec: stub([]), corpusDir: corpusDir(), engine: { kind: 'rust' } });
    expect(rows.map(r => [r.check_id, r.status])).toEqual([['real-fail', 'fail'], ['refused', ENGINE_NOT_SUPPORTED_BY_RUNNER]]);
    expect(rows[1]!.reasons[0]).toContain(ENGINE_NOT_SUPPORTED_BY_RUNNER);
    expect(summarizeChecks(rows).by_status[ENGINE_NOT_SUPPORTED_BY_RUNNER]).toBe(1);
    expect(scenarioStatus(rows)).toBe('fail');
    expect(scenarioStatus(rows.slice(1))).toBe(ENGINE_NOT_SUPPORTED_BY_RUNNER);
  });

  test('a later failing check of a scenario whose earlier write was refused is not supported; a later pass stays a pass', () => {
    const rows = runScenarioChecks({ id: 's5', checks: [
      { id: 'write', description: 'd', run: ['refuse'], expect: { exit: 'zero' } },
      { id: 'read-fails', description: 'd', run: ['ok'], expect: { exit: 'nonzero' } },
      { id: 'read-passes', description: 'd', run: ['ok'], expect: { exit: 'zero' } },
    ] }, { exec: stub([]), corpusDir: corpusDir(), engine: { kind: 'rust' } });
    expect(rows.map(r => r.status)).toEqual([ENGINE_NOT_SUPPORTED_BY_RUNNER, ENGINE_NOT_SUPPORTED_BY_RUNNER, 'pass']);
    expect(rows[1]!.reasons[0]).toContain('earlier check on brain A (write)');
  });

  test('a refusal is never credited to a check that expects a nonzero exit; checks on another brain keep their result', () => {
    const rows = runScenarioChecks({ id: 's6', checks: [
      { id: 'expects-refusal', description: 'd', run: ['refuse'], expect: { exit: 'nonzero' } },
      { id: 'other-brain-fails', description: 'd', run: ['ok'], brain: 'B', expect: { exit: 'nonzero' } },
    ] }, { exec: stub([]), corpusDir: corpusDir(), engine: { kind: 'rust' } });
    expect(rows.map(r => r.status)).toEqual([ENGINE_NOT_SUPPORTED_BY_RUNNER, 'fail']);
  });

  test('a setup step that stops on the typed refusal makes every check of the scenario not supported', () => {
    const rows = runScenarioChecks({ id: 's3', setup: [{ run: ['refuse'] }], checks: [{ id: 'c', description: 'd', run: ['ok'], expect: { exit: 'zero' } }] },
      { exec: stub([]), corpusDir: corpusDir(), engine: { kind: 'rust' } });
    expect(rows.map(r => r.status)).toEqual([ENGINE_NOT_SUPPORTED_BY_RUNNER]);
  });

  test('Postgres meets the postgres requirement and refuses up front without an admin URL', () => {
    expect(engineRequirements('postgres')).toEqual(['postgres']);
    expect(engineRequirements('rust')).toEqual([]);
    expect(() => runScenarioChecks({ id: 's4', checks: [{ id: 'c', description: 'd', run: ['ok'], expect: { exit: 'zero' } }] },
      { exec: stub([]), corpusDir: corpusDir(), engine: { kind: 'postgres' } })).toThrow(/admin URL/);
  });

  test('the refusal pattern matches gbrain\'s two refusal wordings and nothing else', () => {
    expect(ENGINE_REFUSAL_RE.test('engine_capability_missing')).toBe(true);
    expect(ENGINE_REFUSAL_RE.test("This brain's engine does not support listPages yet (it needs the pages capability)")).toBe(true);
    expect(ENGINE_REFUSAL_RE.test('Error: page not found')).toBe(false);
  });
});

describe('Cat 22 seeding on an engine without raw SQL', () => {
  const fakeEngine = (withTyped: boolean) => {
    const calls: string[] = [];
    const engine: Record<string, unknown> = {
      executeRaw: async () => { calls.push('executeRaw'); throw Object.assign(new Error('raw sql refused'), { code: 'engine_capability_missing' }); },
      getSource: async () => null,
      addLink: async (from: string, to: string, _c: string, type: string, _a: unknown, _b: unknown, _d: unknown, o: { fromSourceId: string; toSourceId: string }) => { calls.push(`addLink ${from}@${o.fromSourceId} -> ${to}@${o.toSourceId} ${type}`); },
    };
    if (withTyped) engine.insertSource = async (row: { id: string; config: unknown }) => { calls.push(`insertSource ${row.id} ${JSON.stringify(row.config)}`); };
    return { engine, calls };
  };
  const importStub = async () => ({ status: 'imported' });

  test('uses insertSource and addLink with source ids, never raw SQL', async () => {
    const { engine, calls } = fakeEngine(true);
    const seeded = await seedCorpus(engine, importStub, 'rust');
    expect(calls.filter(c => c === 'executeRaw')).toEqual([]);
    expect(calls.filter(c => c.startsWith('insertSource'))).toEqual(SOURCES.map(s => `insertSource ${s} {"federated":true}`));
    expect(calls.filter(c => c.startsWith('addLink'))).toEqual([
      'addLink graph/hub-alpha@alpha -> graph/spoke-alpha@alpha mentions',
      'addLink graph/hub-alpha@alpha -> graph/leak-beta@beta mentions',
    ]);
    expect(seeded.bySource.get('alpha')!.size).toBe(PAGES_PER_SOURCE * 2 + 2);
  });

  test('a build with neither raw SQL nor insertSource refuses with engine_not_supported_by_runner', async () => {
    const { engine } = fakeEngine(false);
    const err = await seedCorpus(engine, importStub, 'rust').catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineUnavailable);
    expect(err.reason).toBe(ENGINE_NOT_SUPPORTED_BY_RUNNER);
  });
});

describe('Cat 2 stored links', () => {
  test('imports each world page as the BrainBench gbrain adapter does', () => {
    const md = pageMarkdown({ slug: 'people/a', type: 'person', title: 'Ada "A"', compiled_truth: 'Works at [Acme](companies/acme).', timeline: '- 2020: joined' } as never);
    expect(md).toBe('---\ntype: person\ntitle: "Ada \\"A\\""\n---\n\n# Ada "A"\n\nWorks at [Acme](companies/acme).\n\n## Timeline\n\n- 2020: joined');
    expect(pageMarkdown({ slug: 'x', type: 'company', title: 'X', compiled_truth: 'Body', timeline: ' ' } as never)).not.toContain('## Timeline');
  });
});

describe('cleanup and output safety', () => {
  test('gbrain extract exiting on a typed refusal is engine_not_supported_by_runner; another exit is an error; process.exit is restored', async () => {
    const exit = process.exit;
    const refused = await runCliExtract('rust', async () => { console.error("This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran."); process.exit(1); }).catch(e => e);
    expect(refused).toBeInstanceOf(EvalEngineUnavailable);
    expect(refused.reason).toBe(ENGINE_NOT_SUPPORTED_BY_RUNNER);
    const other = await runCliExtract('rust', async () => { console.error('No brain directory configured.'); process.exit(1); }).catch(e => e);
    expect(other).not.toBeInstanceOf(EvalEngineUnavailable);
    expect(String(other.message)).toContain('No brain directory configured');
    expect(process.exit).toBe(exit);
    await runCliExtract('rust', async () => {});
  });

  test('closeOnError closes the brain and rethrows; a success leaves it open', async () => {
    let closed = 0;
    const brain = { close: async () => { closed++; } };
    await expect(closeOnError(brain, async () => { throw new Error('config write failed'); })).rejects.toThrow('config write failed');
    expect(await closeOnError(brain, async () => 3)).toBe(3);
    expect(closed).toBe(1);
  });

  test('redactConnection removes the database host and password from recorded text', () => {
    const url = 'postgres://u:s3cret@db.internal.example:5432/postgres';
    expect(redactConnection('connect to db.internal.example failed (s3cret)', url)).toBe('connect to <pg-host> failed (***)');
    expect(redactConnection('nothing to hide', undefined)).toBe('nothing to hide');
  });
});

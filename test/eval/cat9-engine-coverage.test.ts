/**
 * The engine-coverage Cat 9 scenarios (eval/data/cat9-engine-coverage-v1) and the two runner features they use: a
 * check run as a brain member (GBRAIN_ENFORCED_MEMBER) and a scenario scoped to some engines. Hermetic: a stub stands
 * in for the gbrain CLI, so no brain is opened and no key is read.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runScenarioChecks, validateChecks, type ExecResult, type GbrainExec } from '../../eval/runner/cat9-checks.ts';
import { loadCat9Catalog, validateCatalog } from '../../eval/runner/cat9-workflows.ts';

const CATALOG = resolve(import.meta.dir, '../../eval/data/cat9-engine-coverage-v1/scenarios.json');
const ok = (stdout = '', stderr = '', exit = 0): ExecResult => ({ exit, stdout, stderr });

function stubExec(answer: (argv: string[]) => ExecResult) {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec: GbrainExec = (argv, { home, env }) => {
    calls.push({ argv, env });
    if (argv[0] === 'init') {
      mkdirSync(join(home, '.gbrain', 'brain.pglite'), { recursive: true });
      return ok('initialized');
    }
    return answer(argv);
  };
  return { exec, calls };
}

function tinyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat9-coverage-corpus-'));
  mkdirSync(join(dir, 'puts'), { recursive: true });
  writeFileSync(join(dir, 'puts', 'a.md'), 'BODY');
  return dir;
}

describe('engine-coverage catalog', () => {
  const catalog = loadCat9Catalog(CATALOG);

  test('validates, and every scenario has run checks with expectations', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    expect(catalog.scenarios.length).toBe(8);
    for (const s of catalog.scenarios) {
      expect((s.checks ?? []).length).toBeGreaterThan(0);
      for (const c of s.checks ?? []) expect(c.run && c.expect).toBeTruthy();
    }
  });

  test('every stdin file a step or check names exists in the corpus', () => {
    const corpus = resolve(CATALOG, '..', catalog.fixture.corpus_dir);
    const named = catalog.scenarios.flatMap(s => [...(s.setup ?? []), ...(s.checks ?? [])]).map(x => (x as { stdin?: string }).stdin).filter(Boolean) as string[];
    expect(named.length).toBeGreaterThan(0);
    for (const f of named) expect(existsSync(join(corpus, f))).toBe(true);
    expect(readdirSync(corpus).sort()).toEqual(['default', 'puts', 'work']);
  });

  test('each marker a no-text check looks for is present in a control check first', () => {
    // A "no text left" check that never saw the text could pass on an empty brain. The control check of each
    // deletion scenario must look for the same marker its later checks exclude.
    for (const id of ['ec-01-private-fact-purged', 'ec-02-take-removed', 'ec-03-private-timeline-entry-removed']) {
      const s = catalog.scenarios.find(x => x.id === id)!;
      const text = JSON.stringify(s.checks);
      const marker = (s.checks ?? []).flatMap(c => c.expect?.stdout_excludes ?? [])[0];
      expect(marker).toBeTruthy();
      const control = (s.checks ?? [])[0];
      expect(control.id.startsWith('control-')).toBe(true);
      expect(JSON.stringify(control.expect)).toContain(marker);
      expect(text.split(marker).length).toBeGreaterThan(3);
    }
  });

  test('the swap scenario is scoped to PGLite and Postgres with a reason', () => {
    const swap = catalog.scenarios.find(s => s.id === 'ec-06-engine-swap-refusal')!;
    expect(swap.engines).toEqual(['pglite', 'postgres']);
    expect(swap.engines_note).toContain('Rust');
  });
});

describe('runner: checks run as a member, scenarios scoped to engines', () => {
  test('a check with member runs under GBRAIN_ENFORCED_MEMBER; other calls do not', () => {
    const { exec, calls } = stubExec(() => ok('{}'));
    const rows = runScenarioChecks({
      id: 's-member',
      setup: [{ run: ['put', 'notes/a', '--json'], stdin: 'puts/a.md' }],
      checks: [
        { id: 'as-tess', description: 'as tess', run: ['put', 'notes/a', '--json'], stdin: 'puts/a.md', member: 'tess-example', expect: { exit: 'zero' } },
        { id: 'local', description: 'trusted local', run: ['get', 'notes/a'], expect: { exit: 'zero' } },
      ],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows.map(r => r.status)).toEqual(['pass', 'pass']);
    const byArgv = (a0: string, n: number) => calls.filter(c => c.argv[0] === a0)[n];
    expect(byArgv('init', 0).env).toBeUndefined();
    expect(byArgv('put', 0).env).toBeUndefined();
    expect(byArgv('put', 1).env).toEqual({ GBRAIN_ENFORCED_MEMBER: 'tess-example' });
    expect(byArgv('get', 0).env).toBeUndefined();
  });

  test('a scenario scoped to other engines runs nothing and reports engine_not_supported_by_runner with its note', () => {
    const { exec, calls } = stubExec(() => ok('{}'));
    const scenario = {
      id: 's-scoped', engines: ['pglite', 'postgres'] as const, engines_note: 'Only a PGLite or Postgres brain can be swapped.',
      checks: [{ id: 'c1', description: 'd', run: ['engine', 'swap'], expect: { exit: 'zero' as const } }],
    };
    const rows = runScenarioChecks({ ...scenario, engines: [...scenario.engines] }, { exec, corpusDir: tinyCorpus(), engine: { kind: 'rust' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('engine_not_supported_by_runner');
    expect(rows[0].reasons[0]).toContain('applies to pglite and postgres only');
    expect(rows[0].reasons[0]).toContain('Only a PGLite or Postgres brain can be swapped.');
    expect(calls).toHaveLength(0);
    // On a listed engine (PGLite is the default) it runs.
    const ran = runScenarioChecks({ ...scenario, engines: [...scenario.engines] }, { exec, corpusDir: tinyCorpus() });
    expect(ran[0].status).toBe('pass');
  });

  test('validation: engines need a known engine and a note, and member must be a member id', () => {
    const base = { id: 's', checks: [{ id: 'c', description: 'd', run: ['get', 'x'], expect: { exit: 'zero' as const } }] };
    expect(validateChecks({ ...base, engines: ['pglite'], engines_note: 'why' })).toEqual([]);
    expect(validateChecks({ ...base, engines: ['oracle' as never], engines_note: 'why' }).join(' ')).toContain('engines must list only');
    expect(validateChecks({ ...base, engines: ['pglite'] }).join(' ')).toContain('engines_note');
    expect(validateChecks({ ...base, engines_note: 'why' }).join(' ')).toContain('engines_note without engines');
    expect(validateChecks({ ...base, checks: [{ ...base.checks[0], member: 'Bob Example' }] }).join(' ')).toContain('member must be a member id');
    expect(validateChecks({ ...base, checks: [{ ...base.checks[0], member: 'bob-example' }] })).toEqual([]);
  });

  test('the catalog file on disk is the one the runner reads', () => {
    expect(JSON.parse(readFileSync(CATALOG, 'utf8')).version).toBe(1);
  });
});

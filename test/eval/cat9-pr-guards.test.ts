/**
 * Cat 9 pull-request guards: the scenarios that guard one gbrain pull request's user-visible behavior
 * (pr-guard-* in eval/data/cat9-workflows-v1/scenarios.json) and the free-check features they use: a file
 * expectation, per-step GBRAIN_* settings, a wait, a written file, a stub server child process, scenario engines and
 * the guard label. Hermetic: a stub stands in for the gbrain CLI, and the stub server is a tiny fake module, so no
 * brain is built and no key is read.
 */
import { afterAll, describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MAX_WAIT_MS,
  checkJsonAssertion,
  evaluateExpect,
  runScenarioChecks,
  validateChecks,
  validateExpect,
  validateGuard,
  validateStepEnv,
  type Cat9CheckedScenario,
  type Cat9Guard,
  type ExecResult,
  type GbrainExec,
} from '../../eval/runner/cat9-checks.ts';
import { DEFAULT_CAT9_CATALOG, loadCat9Catalog, runCat9Checks } from '../../eval/runner/cat9-workflows.ts';

const ok = (stdout = '', stderr = '', exit = 0): ExecResult => ({ exit, stdout, stderr });

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function tinyCorpus(): string {
  const dir = tempDir('cat9-guard-corpus-');
  mkdirSync(join(dir, 'puts'), { recursive: true });
  writeFileSync(join(dir, 'puts', 'a.md'), 'BODY');
  return dir;
}

type Call = { argv: string[]; home: string; stdin?: string; env?: Record<string, string> };
function stubExec(answer: (argv: string[], call: Call) => ExecResult): { exec: GbrainExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GbrainExec = (argv, o) => {
    const call = { argv, home: o.home, stdin: o.stdin, env: o.env };
    calls.push(call);
    if (argv[0] === 'init') return ok('{}');
    return answer(argv, call);
  };
  return { exec, calls };
}

const PASS_GUARD: Cat9Guard = {
  pr: 'https://github.com/garrytan/gbrain/pull/1', behavior: 'a behavior', fix_commit: 'a'.repeat(40),
  first_release: 'v0.1.2.3', newest_release: 'v0.1.2.4', expected: 'pass',
};
const check = { id: 'c', description: 'd', run: ['stats'], expect: { exit: 'zero' as const } };

describe('Cat 9 guards: the file expectation', () => {
  test('includes, excludes and absent each report their own failure', () => {
    const files: Record<string, string> = { '/x/shared.html': 'PUBLIC and PRIVATE' };
    const readFile = (p: string) => files[p] ?? null;
    expect(evaluateExpect({ file: { path: '/x/shared.html', includes: ['PUBLIC'], excludes: ['SECRET'] } }, ok(), { readFile })).toEqual([]);
    expect(evaluateExpect({ file: { path: '/x/shared.html', excludes: ['PRIVATE'] } }, ok(), { readFile })).toEqual(['file has "PRIVATE"']);
    expect(evaluateExpect({ file: { path: '/x/shared.html', includes: ['MISSING'] } }, ok(), { readFile })).toEqual(['file lacks "MISSING"']);
    expect(evaluateExpect({ file: { path: '/x/none.html', excludes: ['PRIVATE'] } }, ok(), { readFile })).toEqual(['file was not written']);
    expect(evaluateExpect({ file: { path: '/x/none.html', absent: true } }, ok(), { readFile })).toEqual([]);
    expect(evaluateExpect({ file: { path: '/x/shared.html', absent: true } }, ok(), { readFile })).toEqual(['file exists, expected nothing written']);
  });

  test('a file expectation must say what to check', () => {
    expect(validateExpect({ file: { path: 'p' } }, 'w').join('\n')).toContain('needs includes, excludes or absent');
    expect(validateExpect({ file: { path: 'p', absent: true, excludes: ['x'] } }, 'w').join('\n')).toContain('absent takes no');
    expect(validateExpect({ file: { path: 'p', excludes: [] } }, 'w').join('\n')).toContain('non-empty list');
    expect(validateExpect({ file: { includes: ['x'] } }, 'w').join('\n')).toContain('file needs a path');
    expect(validateExpect({ file: { path: 'p', excludes: ['x'], typo: 1 } }, 'w').join('\n')).toContain('unknown file key');
    expect(validateExpect({ file: { path: 'p', excludes: ['x'] } }, 'w')).toEqual([]);
  });
});

describe('Cat 9 guards: validation', () => {
  test('a step may set GBRAIN_* settings, never a key or token', () => {
    expect(validateStepEnv({ GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: '0.0005' }, 'w')).toEqual([]);
    for (const name of ['OPENAI_API_KEY', 'GBRAIN_API_KEY', 'GBRAIN_AUTH_TOKEN', 'GBRAIN_DB_PASSWORD', 'PATH']) {
      expect(validateStepEnv({ [name]: 'x' }, 'w').join('\n')).toContain('never a key or token');
    }
    expect(validateStepEnv({ GBRAIN_X: 1 }, 'w').join('\n')).toContain('must be a string');
  });

  test('new setup steps are checked for shape', () => {
    const problems = validateChecks({
      id: 's', checks: [check],
      setup: [
        { wait_ms: 0 }, { wait_ms: MAX_WAIT_MS + 1 }, { write_file: 'f', content: 'c', mode: '0x1' },
        { stub_server: 'nope' as never, contacts: {}, capture: { p: 'port' } },
        { stub_server: 'apple-contacts', contacts: {}, capture: { p: 'host' as never } },
        { run: ['stats'], env: { OPENAI_API_KEY: 'x' } },
      ],
    }).join('\n');
    expect(problems).toContain('wait_ms must be a whole number');
    expect(problems).toContain('mode must be three octal digits');
    expect(problems).toContain('stub_server must be one of apple-contacts');
    expect(problems).toContain('capture maps names to port, token, requests_log');
    expect(problems).toContain('never a key or token');
  });

  test('engines must name real engines and carry a reason', () => {
    expect(validateChecks({ id: 's', checks: [check], engines: ['postgres'] }).join('\n')).toContain('engines needs an engines_reason');
    expect(validateChecks({ id: 's', checks: [check], engines: ['mysql' as never], engines_reason: 'r' }).join('\n')).toContain('engines must list only');
    expect(validateChecks({ id: 's', checks: [check], engines_reason: 'r' }).join('\n')).toContain('engines_reason without engines');
    expect(validateChecks({ id: 's', checks: [check], engines: ['postgres', 'rust'], engines_reason: 'r' })).toEqual([]);
  });

  test('a guard expecting pass names the shipped fix and labels no check a known failure', () => {
    expect(validateGuard({ id: 's', checks: [check], guards: PASS_GUARD })).toEqual([]);
    const labelled = validateGuard({ id: 's', checks: [{ ...check, known_failure: { finding: 'F', note: 'n' } }], guards: PASS_GUARD }).join('\n');
    expect(labelled).toContain('expected pass, but c is labelled a known failure');
    expect(validateGuard({ id: 's', checks: [check], guards: { ...PASS_GUARD, fix_commit: null, first_release: null } }).join('\n')).toContain('needs the fix_commit and first_release');
    expect(validateGuard({ id: 's', checks: [check], guards: { ...PASS_GUARD, pr: 'gbrain#1' } }).join('\n')).toContain('GitHub pull request URL');
    expect(validateGuard({ id: 's', checks: [], guards: PASS_GUARD }).join('\n')).toContain('at least one mechanized check');
  });

  test('a guard whose fix has not shipped expects expected_fail, with the pull request on every check', () => {
    const open: Cat9Guard = { ...PASS_GUARD, fix_commit: null, first_release: null, expected: 'expected_fail' };
    expect(validateGuard({ id: 's', checks: [check], guards: open }).join('\n')).toContain('needs a known_failure whose note names');
    expect(validateGuard({ id: 's', checks: [{ ...check, known_failure: { finding: 'F', note: `not shipped: ${open.pr}` } }], guards: open })).toEqual([]);
  });
});

describe('Cat 9 guards: running the new steps with a stub CLI', () => {
  test('a scenario defined on other engines runs nothing and is engine_not_supported_by_runner with its reason', () => {
    const { exec, calls } = stubExec(() => ok());
    const rows = runScenarioChecks({ id: 's', engines: ['postgres'], engines_reason: 'PGLite drains the queue itself.', setup: [{ run: ['stats'] }], checks: [check] },
      { exec, corpusDir: tinyCorpus() });
    expect(rows.map(r => r.status)).toEqual(['engine_not_supported_by_runner']);
    expect(rows[0].reasons[0]).toContain('runs on postgres only. PGLite drains the queue itself.');
    expect(calls).toHaveLength(0);
  });

  test('a check env reaches only that call, and write_file writes a substituted file with its mode', () => {
    let mode = -1;
    const { exec, calls } = stubExec(argv => {
      if (argv[0] !== 'show') return ok('{"v":"tok-1"}');
      mode = statSync(argv[1]).mode & 0o777;
      return ok(readFileSync(argv[1], 'utf8'));
    });
    const rows = runScenarioChecks({
      id: 's',
      setup: [
        { run: ['mint'], capture: { token: 'v' } },
        { write_file: '{corpus}/secrets/t.json', content: '{"accessToken":"{token}"}', mode: '600' },
        { wait_ms: 5 },
      ],
      checks: [{ id: 'c', description: 'd', run: ['show', '{corpus}/secrets/t.json'], env: { GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: '0.0005' },
        expect: { json: [{ path: 'accessToken', op: 'eq', value: 'tok-1' }], file: { path: '{corpus}/secrets/t.json', includes: ['tok-1'] } } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows.map(r => r.status)).toEqual(['pass']);
    expect(calls.find(c => c.argv[0] === 'mint')!.env).toBeUndefined();
    expect(calls.find(c => c.argv[0] === 'show')!.env).toEqual({ GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: '0.0005' });
    expect(mode).toBe(0o600);
  });

  test('stub_server serves from a child process while checks run, and stops when the scenario ends', () => {
    const root = tempDir('cat9-guard-gbrain-');
    mkdirSync(join(root, 'test/helpers'), { recursive: true });
    writeFileSync(join(root, 'test/helpers/apple-contacts-stub.ts'), [
      "export const STUB_TOKEN = 'fake-token';",
      'export class ContactsStub {',
      '  contacts = new Map(); server: any = null;',
      '  upsert(id: string, c: unknown) { this.contacts.set(id, c); }',
      '  answer(req: Request) { return new Response(JSON.stringify([...this.contacts.keys()])); }',
      "  start() { this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req: Request) => this.answer(req) }); return this; }",
      '  get port() { return this.server.port; }',
      '}',
    ].join('\n'));
    const fetchSync = (port: string) => Bun.spawnSync([process.execPath, '-e', `try { console.log(await (await fetch('http://127.0.0.1:${port}/')).text()); } catch { console.log('down'); }`]).stdout.toString().trim();
    let port = '';
    const { exec } = stubExec(argv => { port = argv[1]; return ok(fetchSync(argv[1])); });
    const rows = runScenarioChecks({
      id: 's',
      setup: [{ stub_server: 'apple-contacts', contacts: { 'c-1': { given_name: 'A' } }, capture: { p: 'port', t: 'token', log: 'requests_log' } }],
      checks: [{ id: 'c', description: 'd', run: ['ask', '{p}', '{t}'], expect: { stdout_includes: ['c-1'], file: { path: '{log}', includes: ['GET /'], excludes: ['POST'] } } }],
    }, { exec, corpusDir: tinyCorpus(), gbrainRoot: root });
    expect(rows.map(r => r.status)).toEqual(['pass']);
    expect(rows[0].argv![2]).toBe('fake-token');
    expect(fetchSync(port)).toBe('down');
  });

  test('stub_server on a build without the stub is not_run with that reason, never a pass, a fail or an error', () => {
    const { exec, calls } = stubExec(() => ok());
    const rows = runScenarioChecks({ id: 's', setup: [{ run: ['stats'] }, { stub_server: 'apple-contacts', contacts: {}, capture: { p: 'port' } }], checks: [check] },
      { exec, corpusDir: tinyCorpus(), gbrainRoot: tempDir('cat9-guard-empty-') });
    expect(rows.map(r => r.status)).toEqual(['not_run']);
    expect(rows[0].reasons[0]).toContain('this gbrain build has no such file');
    expect(calls.filter(c => c.argv[0] === 'stats')).toHaveLength(1);
  });

  test('rows_eq matches rows on the listed keys in any order, and fails a value on the wrong card or an extra row', () => {
    const doc = { changes: [{ id: 'a', field: 'job', value: 'X', key: 1 }, { id: 'b', field: 'job', value: 'Y', key: 2 }] };
    const want = [{ id: 'b', field: 'job', value: 'Y' }, { id: 'a', field: 'job', value: 'X' }];
    expect(checkJsonAssertion(doc, { path: 'changes', op: 'rows_eq', value: want })).toBeNull();
    const swapped = { changes: [{ id: 'a', field: 'job', value: 'Y' }, { id: 'b', field: 'job', value: 'X' }] };
    expect(checkJsonAssertion(swapped, { path: 'changes', op: 'rows_eq', value: want })).toContain('rows differ');
    const extra = { changes: [...doc.changes, { id: 'b', field: 'emails', value: 'Z' }] };
    expect(checkJsonAssertion(extra, { path: 'changes', op: 'rows_eq', value: want })).toContain('rows differ');
    expect(checkJsonAssertion({ changes: [] }, { path: 'changes', op: 'rows_eq', value: [] })).toContain('non-empty list');
    expect(checkJsonAssertion({}, { path: 'changes', op: 'rows_eq', value: want })).toContain('not an array');
  });
});

describe('Cat 9 guards: the committed pr-guard scenarios', () => {
  const catalog = loadCat9Catalog(DEFAULT_CAT9_CATALOG);
  const guards = catalog.scenarios.filter(s => s.id.startsWith('pr-guard-'));

  test('three scenarios guard gbrain pull requests 10035, 9973 and 9950, each with a valid label', () => {
    expect(guards.map(s => s.guards?.pr)).toEqual([
      'https://github.com/garrytan/gbrain/pull/10035',
      'https://github.com/garrytan/gbrain/pull/9973',
      'https://github.com/garrytan/gbrain/pull/9950',
    ]);
    for (const s of guards) expect(validateGuard(s as Cat9CheckedScenario)).toEqual([]);
  });

  test('all three fixes shipped in v0.60.763.0, so each expects pass on the newest release and labels no known failure', () => {
    for (const s of guards) {
      expect(s.guards).toMatchObject({ first_release: 'v0.60.763.0', newest_release: 'v0.60.765.0', expected: 'pass' });
      for (const c of s.checks ?? []) expect(c.known_failure).toBeUndefined();
    }
  });

  test('the publish guard looks for every private marker the corpus page carries, and for its public text', () => {
    const s = guards.find(g => g.id === 'pr-guard-10035-publish-private')!;
    const page = readFileSync(join(DEFAULT_CAT9_CATALOG, '..', 'corpus/puts/sam-private.md'), 'utf8');
    const markers = [...page.matchAll(/\b(PRIVATE|PUBLIC)-[A-Z-]+[A-Z]\b/g)].map(m => m[0]);
    for (const c of s.checks!.filter(c => c.id.startsWith('publish-') && c.expect?.file?.excludes)) {
      expect([...c.expect!.file!.excludes!, ...c.expect!.file!.includes!].sort()).toEqual([...new Set(markers)].sort());
    }
  });

  test('the no-worker guard runs where facts-absorb jobs wait for a worker, and only its second check lowers the threshold', () => {
    const s = guards.find(g => g.id === 'pr-guard-9973-dream-no-worker')!;
    expect(s.engines).toEqual(['postgres', 'rust']);
    expect(s.checks!.map(c => c.env ?? null)).toEqual([null, { GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: '0.0005' }]);
    const wait = s.setup!.find(st => 'wait_ms' in st) as { wait_ms: number };
    // The wait must outlast the lowered threshold (0.0005 h = 1.8 s) and stay far under the default hour.
    expect(wait.wait_ms).toBeGreaterThan(1800);
  });

  test('the contacts guard has a positive control for the confirmed email it expects to be left out', () => {
    const s = guards.find(g => g.id === 'pr-guard-9950-contacts-enrich-adds-only')!;
    const said = s.setup!.filter(st => 'run' in st && st.run[0] === 'remember').map(st => (st as { run: string[] }).run);
    expect(said.some(r => r[1] === 'Email: tess.home@mail.example' && r.includes('user_said'))).toBe(true);
    expect(said.some(r => r[1] === 'Email: tess.guess@mail.example' && r.includes('inferred'))).toBe(true);
    const rows = s.checks![0].expect!.json!.find(a => a.op === 'rows_eq')!.value as Array<Record<string, string>>;
    expect(rows.some(r => r.value === 'tess.home@mail.example' && r.id === 'c-tess')).toBe(true);
    expect(rows.some(r => r.value === 'tess.guess@mail.example')).toBe(false);
  });

  test('the contacts guard switches writes on, so only dry_run keeps the batch unsent, and proves a send would show', () => {
    const s = guards.find(g => g.id === 'pr-guard-9950-contacts-enrich-adds-only')!;
    expect(s.setup!.some(st => 'run' in st && st.run.join(' ') === 'config set apple_contacts.write on' && !st.allow_fail)).toBe(true);
    const ids = s.checks!.map(c => c.id);
    expect(ids.indexOf('dry-run-sends-no-batch-with-writes-on')).toBeLessThan(ids.indexOf('control-on-sends-a-batch'));
    expect(s.checks!.find(c => c.id === 'dry-run-sends-no-batch-with-writes-on')!.expect!.file!.excludes).toEqual(['POST']);
    expect(s.checks!.find(c => c.id === 'control-on-sends-a-batch')!.expect!.file!.includes).toEqual(['POST /v1/contacts/batch']);
  });

  test('runCat9Checks carries the guard label into the report row', () => {
    const { exec } = stubExec(() => ok('{}'));
    const report = runCat9Checks({ catalog, catalogPath: DEFAULT_CAT9_CATALOG, exec, gbrain: { version: 'x', commit: 'y' }, only: ['pr-guard-10035-publish-private'] });
    expect(report.scenarios[0].guards).toEqual({ pr: 'https://github.com/garrytan/gbrain/pull/10035', newest_release: 'v0.60.765.0', expected: 'pass' });
    // The stub CLI writes no shared file, so the publish checks fail rather than pass on nothing.
    expect(report.scenarios[0].checks.map(c => c.status)).toEqual(['fail', 'fail', 'fail']);
  });
});

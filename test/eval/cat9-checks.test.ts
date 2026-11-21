/**
 * Cat 9 free checks (eval/runner/cat9-checks.ts) and the committed scenario
 * catalog (eval/data/cat9-workflows-v1). Hermetic: a stub stands in for the
 * gbrain CLI, so no brain is built and no key is read.
 */
import { describe, test, expect } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import {
  CAT9_REQUIREMENTS,
  checkJsonAssertion,
  classify,
  evaluateExpect,
  hermeticChildEnv,
  jsonPath,
  parseJsonOutput,
  runScenarioChecks,
  scenarioStatus,
  substitute,
  substituteDeep,
  validateChecks,
  type Cat9CheckedScenario,
  type ExecResult,
  type GbrainExec,
} from '../../eval/runner/cat9-checks.ts';
import {
  ALL_WORKFLOWS,
  CAT9_CHECKS_CATEGORY,
  DEFAULT_CAT9_CATALOG,
  buildEvidence,
  corpusPagesForCatalog,
  loadCat9Catalog,
  renderChecksTable,
  runCat9,
  runCat9Checks,
  validateCatalog,
  type Cat9Catalog,
} from '../../eval/runner/cat9-workflows.ts';
import type { AgentRunResult } from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const ok = (stdout = '', stderr = '', exit = 0): ExecResult => ({ exit, stdout, stderr });

describe('Cat 9 checks: jsonPath and assertions', () => {
  const doc = { a: { b: 2 }, list: [{ slug: 'x', source_id: 'default' }, { slug: 'y', source_id: 'default' }], empty: [] };

  test('reads dotted paths, length and [*] maps', () => {
    expect(jsonPath(doc, 'a.b')).toBe(2);
    expect(jsonPath(doc, 'list.length')).toBe(2);
    expect(jsonPath(doc, 'list[*].slug')).toEqual(['x', 'y']);
    expect(jsonPath(doc, 'list.1.slug')).toBe('y');
    expect(jsonPath(doc, '')).toBe(doc);
    expect(jsonPath(doc, 'a.missing.deeper')).toBeUndefined();
  });

  test('each op passes and fails where it should', () => {
    expect(checkJsonAssertion(doc, { path: 'a.b', op: 'eq', value: 2 })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'a.b', op: 'eq', value: 3 })).toContain('not equal');
    expect(checkJsonAssertion(doc, { path: 'a.b', op: 'gt', value: 1 })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'a.b', op: 'lt', value: 2 })).not.toBeNull();
    expect(checkJsonAssertion(doc, { path: 'list', op: 'nonempty' })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'empty', op: 'empty' })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'list[*].slug', op: 'includes', value: 'x' })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'list[*].source_id', op: 'excludes', value: 'work' })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'list[*].source_id', op: 'excludes', value: 'default' })).toContain('value in array');
    expect(checkJsonAssertion(doc, { path: 'list', op: 'length', value: 2 })).toBeNull();
    expect(checkJsonAssertion(doc, { path: 'fix.argv', op: 'exists' })).toContain('missing');
    expect(checkJsonAssertion(doc, { path: 'fix.argv', op: 'absent' })).toBeNull();
    // ne never passes on a missing value: absence is not "different".
    expect(checkJsonAssertion(doc, { path: 'code', op: 'ne', value: 'recovery_required' })).not.toBeNull();
  });

  test('excludes fails on a missing array instead of passing vacuously', () => {
    expect(checkJsonAssertion(doc, { path: 'nope[*].slug', op: 'excludes', value: 'x' })).toContain('not an array');
  });

  test('all_match never passes on an empty array', () => {
    expect(checkJsonAssertion(doc, { path: 'empty', op: 'all_match', value: '^\\d' })).toContain('no values');
    expect(checkJsonAssertion({ d: ['2025-01-06'] }, { path: 'd', op: 'all_match', value: '^\\d{4}-\\d{2}-\\d{2}$' })).toBeNull();
    expect(checkJsonAssertion({ d: ['2025-01-06T00:00:00Z'] }, { path: 'd', op: 'all_match', value: '^\\d{4}-\\d{2}-\\d{2}$' })).toContain('do not match');
  });

  test('parseJsonOutput skips notice lines before and after the JSON', () => {
    expect(parseJsonOutput('[gbrain] notice\n{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonOutput('[gbrain] notice\n[\n  {"a": 1}\n]\n[gbrain degraded: x] note')).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(parseJsonOutput('plain text')).toEqual({ ok: false });
  });

  test('parseJsonOutput never recovers a nested document from malformed JSON', () => {
    const truncated = '{\n  "outer": 1,\n  "inner":\n{"pages": ["x"]}';
    expect(parseJsonOutput(truncated)).toEqual({ ok: false });
    expect(evaluateExpect({ json: [{ path: 'pages', op: 'nonempty' }] }, ok(truncated))).toEqual(['stdout is not JSON']);
  });

  test('an unknown op fails closed', () => {
    expect(checkJsonAssertion(doc, { path: 'a.b', op: 'equals' as any, value: 2 })).toContain('unknown op');
  });

  test('some_match passes when one string matches', () => {
    expect(checkJsonAssertion({ argv: ['gbrain', 'sources', 'transfer'] }, { path: 'argv', op: 'some_match', value: 'transfer' })).toBeNull();
    expect(checkJsonAssertion({ argv: ['gbrain', '--help'] }, { path: 'argv', op: 'some_match', value: 'transfer' })).toContain('no value matches');
  });
});

describe('Cat 9 checks: evaluateExpect and classify', () => {
  test('exit, text and json conditions each report their own failure', () => {
    const r = ok('{"code":"revision_conflict"}', 'warn #3070', 1);
    expect(evaluateExpect({ exit: 'nonzero', json: [{ path: 'code', op: 'eq', value: 'revision_conflict' }] }, r)).toEqual([]);
    const reasons = evaluateExpect({ exit: 'zero', stderr_excludes: ['#3070'], stdout_includes: ['missing'], output_excludes: ['warn'] }, r);
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toContain('exit 1');
  });

  test('lines rules read only the lines with the prefix, and need one to exist', () => {
    const r = ok('', 'notice: pass --source work\nFix: gbrain get x --source default');
    expect(evaluateExpect({ lines: [{ prefix: 'Fix:', excludes: ['--source work'], includes: ['--source default'] }] }, r)).toEqual([]);
    expect(evaluateExpect({ lines: [{ prefix: 'Fix:', excludes: ['--source default'] }] }, r)[0]).toContain('line has');
    expect(evaluateExpect({ lines: [{ prefix: 'Why:' }] }, r)[0]).toContain('no line starts with');
  });

  test('a json assertion on non-JSON output fails', () => {
    expect(evaluateExpect({ json: [{ path: '', op: 'nonempty' }] }, ok('No results.'))).toEqual(['stdout is not JSON']);
  });

  test('datastore_absent asks the brain context', () => {
    expect(evaluateExpect({ datastore_absent: 'A' }, ok(), { datastoreExists: () => true })[0]).toContain('exists again');
    expect(evaluateExpect({ datastore_absent: 'A' }, ok(), { datastoreExists: () => false })).toEqual([]);
  });

  test('a known failure labels a fail and flags a pass; it never turns a fail into a pass', () => {
    const kf = { finding: 'N2', note: 'links not built' };
    expect(classify(['x'], kf)).toBe('expected_fail');
    expect(classify([], kf)).toBe('unexpected_pass');
    expect(classify(['x'], undefined)).toBe('fail');
    expect(classify([], undefined)).toBe('pass');
  });

  test('scenarioStatus picks the worst status', () => {
    const row = (status: any) => ({ scenario_id: 's', check_id: 'c', status, finding: null, reasons: [], exit_code: 0, argv: null });
    expect(scenarioStatus([])).toBe('no_checks');
    expect(scenarioStatus([row('pass'), row('not_run')])).toBe('pass');
    expect(scenarioStatus([row('pass'), row('expected_fail')])).toBe('expected_fail');
    expect(scenarioStatus([row('expected_fail'), row('fail')])).toBe('fail');
    expect(scenarioStatus([row('not_run')])).toBe('not_run');
  });
});

describe('Cat 9 checks: placeholders and validation', () => {
  test('substitute leaves regex quantifiers alone', () => {
    expect(substitute('^\\d{4}-\\d{2}$', {})).toBe('^\\d{4}-\\d{2}$');
  });

  test('substitute replaces known names and refuses unknown ones', () => {
    expect(substitute('{corpus}/default', { corpus: '/c' })).toBe('/c/default');
    expect(() => substitute('{rev}', {})).toThrow('unknown placeholder {rev}');
    expect(substituteDeep({ json: [{ path: 'revision', op: 'ne', value: '{r}' }] }, { r: 'abc' })).toEqual({ json: [{ path: 'revision', op: 'ne', value: 'abc' }] });
  });

  test('validateChecks refuses malformed steps and checks', () => {
    const bad: Cat9CheckedScenario = {
      id: 's',
      setup: [{ run: ['gbrain', 'import'] }, { manual: 'do a thing', requires: [] }, { run: ['x'], capture_time: 't' } as any],
      checks: [
        { id: 'a', description: 'd', run: ['stats'], expect: {} },
        { id: 'a', description: '', run: ['stats'], expect: { exit: 'zero' }, requires: ['magic' as any] },
        { id: 'b', description: 'd' },
        { id: 'c', description: 'd', run: ['stats'], expect: { exit: 'zero' }, known_failure: { finding: '', note: '' } },
      ],
    };
    const problems = validateChecks(bad).join('\n');
    expect(problems).toContain('omits the leading gbrain');
    expect(problems).toContain('manual step must say what it requires');
    expect(problems).toContain('exactly one of');
    expect(problems).toContain('expect is empty');
    expect(problems).toContain('missing or repeated');
    expect(problems).toContain('description missing');
    expect(problems).toContain('requires must list only');
    expect(problems).toContain('not_mechanized');
    expect(problems).toContain('known_failure needs finding and note');
  });

  test('validateCatalog refuses vacuous or misspelled expectations through loadCat9Catalog', () => {
    const base = JSON.parse(readFileSync(DEFAULT_CAT9_CATALOG, 'utf8')) as Cat9Catalog;
    const s0 = base.scenarios[0];
    const bad: Cat9Catalog = { ...base, scenarios: [{ ...s0, checks: [
      { id: 'e1', description: 'd', run: ['stats'], expect: { json: [] } },
      { id: 'e2', description: 'd', run: ['stats'], expect: { stdout_include: ['x'] } as any },
      { id: 'e3', description: 'd', run: ['stats'], expect: { json: [{ path: 'a', op: 'equals' as any, value: 1 }] } },
      { id: 'e4', description: 'd', run: ['stats'], expect: { json: [{ path: 'a', op: 'gt' }] } },
      { id: 'e5', description: 'd', run: ['stats'], expect: { stdout_excludes: [] } },
      { id: 'e6', description: 'd', run: ['stats'], expect: { exit: 'ok' as any } },
    ] }] };
    const problems = validateCatalog(bad).join('\n');
    expect(problems).toContain('e1: json must be a non-empty list');
    expect(problems).toContain('e2: unknown expect key "stdout_include"');
    expect(problems).toContain('e3: unknown json op "equals"');
    expect(problems).toContain('e4: json op gt needs value');
    expect(problems).toContain('e5: stdout_excludes must be a non-empty list');
    expect(problems).toContain('e6: exit must be zero or nonzero');
    const dir = mkdtempSync(join(tmpdir(), 'cat9-badcat-'));
    writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(bad));
    expect(() => loadCat9Catalog(join(dir, 'scenarios.json'))).toThrow('unknown json op');
  });

  test('hermeticChildEnv strips provider keys and GBRAIN_ settings', () => {
    const env = hermeticChildEnv('/h', { PATH: '/bin', OPENAI_API_KEY: 'k', SOME_API_KEY: 'k', GBRAIN_DECIDE_SLOTS: '1', GBRAIN_HOME: '/old' });
    expect(env).toEqual({ PATH: '/bin', GBRAIN_HOME: '/h' });
  });
});

/** A fake gbrain: records calls and answers from a script keyed by the command. */
function stubExec(answer: (argv: string[], stdin?: string) => ExecResult) {
  const calls: { argv: string[]; home: string; stdin?: string }[] = [];
  const exec: GbrainExec = (argv, { home, stdin }) => {
    calls.push({ argv, home, stdin });
    if (argv[0] === 'init') {
      mkdirSync(join(home, '.gbrain', 'brain.pglite'), { recursive: true });
      return ok('initialized');
    }
    return answer(argv, stdin);
  };
  return { exec, calls };
}

function tinyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat9-corpus-'));
  mkdirSync(join(dir, 'default/people'), { recursive: true });
  mkdirSync(join(dir, 'puts'), { recursive: true });
  writeFileSync(join(dir, 'default/people/a-example.md'), '---\ntitle: A Example\n---\nA.');
  writeFileSync(join(dir, 'puts/a.md'), 'BODY');
  return dir;
}

describe('Cat 9 checks: runScenarioChecks with a stub CLI', () => {
  test('setup captures flow into check argv and expectations; stdin comes from the corpus copy', () => {
    const corpus = tinyCorpus();
    const { exec, calls } = stubExec((argv, stdin) => {
      if (argv[0] === 'put' && !argv.includes('--expected-revision')) return ok(JSON.stringify({ revision: 'r1' }));
      if (argv[0] === 'put') return ok(JSON.stringify({ revision: 'r2', status: 'created_or_updated', got_stdin: stdin }));
      return ok('[]');
    });
    const rows = runScenarioChecks({
      id: 's1',
      setup: [{ run: ['put', 'people/a-example', '--json'], stdin: 'puts/a.md', capture: { rev1: 'revision' } }],
      checks: [{
        id: 'update', description: 'new revision', run: ['put', 'people/a-example', '--expected-revision', '{rev1}', '--json'], stdin: 'puts/a.md',
        expect: { exit: 'zero', json: [{ path: 'revision', op: 'ne', value: '{rev1}' }, { path: 'got_stdin', op: 'eq', value: 'BODY' }] },
      }],
    }, { exec, corpusDir: corpus });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pass');
    expect(rows[0].argv).toEqual(['put', 'people/a-example', '--expected-revision', 'r1', '--json']);
    expect(calls.filter(c => c.argv[0] === 'init')).toHaveLength(1);
    // The committed corpus is never written to: the run works on a copy.
    expect(readdirSync(corpus).sort()).toEqual(['default', 'puts']);
  });

  test('{corpus} points at a per-scenario copy, and each named brain gets its own home', () => {
    const corpus = tinyCorpus();
    const { exec, calls } = stubExec(() => ok('{}'));
    runScenarioChecks({
      id: 's2',
      setup: [{ run: ['import', '{corpus}/default'], brain: 'A' }],
      checks: [{ id: 'b', description: 'd', run: ['stats', '--json'], brain: 'B', expect: { exit: 'zero' } }],
    }, { exec, corpusDir: corpus });
    const importArg = calls.find(c => c.argv[0] === 'import')!.argv[1];
    expect(importArg.startsWith(corpus)).toBe(false);
    expect(importArg.endsWith('/corpus/default')).toBe(true);
    const homes = new Set(calls.filter(c => c.argv[0] === 'init').map(c => c.home));
    expect(homes.size).toBe(2);
  });

  test('a missing requirement is not_run with its reason, and nothing is executed for it', () => {
    const { exec, calls } = stubExec(() => ok('{}'));
    const rows = runScenarioChecks({
      id: 's3',
      checks: [
        { id: 'keyed', description: 'd', run: ['doctor'], requires: ['embeddings'], expect: { exit: 'zero' } },
        { id: 'unmech', description: 'd', requires: ['mcp_server'], not_mechanized: 'no CLI call' },
      ],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows.map(r => r.status)).toEqual(['not_run', 'not_run']);
    expect(rows[0].reasons[0]).toContain('embedding provider');
    expect(calls.filter(c => c.argv[0] !== 'init')).toHaveLength(0);
  });

  test('a manual setup step marks every check not_run without building a brain', () => {
    const { exec, calls } = stubExec(() => ok('{}'));
    const rows = runScenarioChecks({
      id: 's4',
      setup: [{ manual: 'inject a fault', requires: ['fault_injection'] }],
      checks: [{ id: 'c', description: 'd', run: ['entity', 'x'], expect: { exit: 'nonzero' } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0].status).toBe('not_run');
    expect(rows[0].reasons[0]).toContain('setup not run');
    expect(calls).toHaveLength(0);
  });

  test('a failed setup step makes every check a harness error, never a fail', () => {
    const { exec } = stubExec(argv => (argv[0] === 'import' ? ok('', 'boom', 1) : ok('{}')));
    const rows = runScenarioChecks({
      id: 's5',
      setup: [{ run: ['import', '{corpus}/default'] }],
      checks: [{ id: 'c', description: 'd', run: ['stats'], expect: { exit: 'zero' }, known_failure: { finding: 'N2', note: 'n' } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0].status).toBe('error');
    expect(rows[0].reasons[0]).toContain('harness: setup[0]');
    expect(rows[0].reasons[0]).not.toContain(tmpdir());
  });

  test('remove_datastore moves the PGLite directory, so datastore_absent can see a re-create', () => {
    const { exec } = stubExec((argv) => ok(JSON.stringify({ health_score: argv[0] === 'doctor' ? 95 : 0 })));
    const rows = runScenarioChecks({
      id: 's6',
      setup: [{ remove_datastore: 'A' }],
      checks: [{ id: 'c', description: 'd', run: ['doctor', '--json'], expect: { datastore_absent: 'A', json: [{ path: 'health_score', op: 'lt', value: 100 }] } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0].status).toBe('pass');
  });

  test('an all_match regex runs through the scenario path without being read as a placeholder', () => {
    const { exec } = stubExec(() => ok(JSON.stringify([{ date: '2025-01-06' }])));
    const rows = runScenarioChecks({
      id: 's8',
      checks: [{ id: 'c', description: 'd', run: ['timeline', 'x', '--json'], expect: { json: [{ path: '[*].date', op: 'all_match', value: '^\\d{4}-\\d{2}-\\d{2}$' }] } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0].status).toBe('pass');
  });

  test('read_json captures a value from a file the brain wrote', () => {
    const corpus = tinyCorpus();
    writeFileSync(join(corpus, 'default/.marker'), JSON.stringify({ brain_id: 'b-123' }));
    const { exec } = stubExec(() => ok('owned by b-123'));
    const rows = runScenarioChecks({
      id: 's9',
      setup: [{ read_json: '{corpus}/default/.marker', capture: { owner: 'brain_id' } }],
      checks: [{ id: 'c', description: 'd', run: ['sources', 'add'], expect: { output_includes: ['{owner}'] } }],
    }, { exec, corpusDir: corpus });
    expect(rows[0].status).toBe('pass');
  });

  test('reasons that quote an observed temp path are masked', () => {
    let seen = '';
    const { exec } = stubExec((argv) => { seen = argv[1]; return ok(JSON.stringify({ path: argv[1] })); });
    const rows = runScenarioChecks({
      id: 's10',
      checks: [{ id: 'c', description: 'd', run: ['x', '{corpus}'], expect: { json: [{ path: 'path', op: 'eq', value: 'other' }] } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0].status).toBe('fail');
    expect(seen.length).toBeGreaterThan(0);
    expect(rows[0].reasons.join(' ')).not.toContain(seen);
    expect(rows[0].reasons.join(' ')).toContain('<tmp>/corpus');
  });

  test('a known failure that fails is expected_fail and keeps its finding', () => {
    const { exec } = stubExec(() => ok('[]'));
    const rows = runScenarioChecks({
      id: 's7',
      checks: [{ id: 'c', description: 'd', run: ['backlinks', 'x', '--json'], expect: { json: [{ path: '', op: 'nonempty' }] }, known_failure: { finding: 'N2', note: 'n' } }],
    }, { exec, corpusDir: tinyCorpus() });
    expect(rows[0]).toMatchObject({ status: 'expected_fail', finding: 'N2', exit_code: 0 });
  });
});

// ─── The committed catalog ─────────────────────────────────────────────

const catalog = loadCat9Catalog();
const corpusDir = join(DEFAULT_CAT9_CATALOG, '..', catalog.fixture.corpus_dir);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) markdownFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe('Cat 9 catalog (eval/data/cat9-workflows-v1)', () => {
  test('validates, with 24 scenarios across the five workflows', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    expect(catalog.scenarios).toHaveLength(24);
    for (const w of new Set(catalog.scenarios.map(s => s.workflow))) expect(ALL_WORKFLOWS).toContain(w);
  });

  test('the corpus holds the 37 fixture files', () => {
    expect(markdownFiles(corpusDir)).toHaveLength(37);
  });

  test('every ground_truth_slug resolves to a corpus page or a page a scenario saves (judged path stays usable)', () => {
    const pages = corpusPagesForCatalog(catalog, DEFAULT_CAT9_CATALOG);
    const empty: AgentRunResult = {
      final_answer: '', evidence_refs: [], stop_reason: 'end_turn', brain_first_ordering: 'no_answer', total_cost_usd: 0, transcript: {} as any,
      tool_bridge_state: { count_by_tool: {}, saw_poison_items: [], made_dry_run_writes: [] } as any,
    } as unknown as AgentRunResult;
    for (const s of catalog.scenarios) {
      const ev = buildEvidence(s, empty, pages);
      expect(ev.ground_truth_pages.map(p => p.slug)).toEqual(s.ground_truth_slugs);
    }
    expect(pages.get('people/olive-example')!.content).toContain('previously ran finance');
  });

  test('every wikilink in the corpus points at a corpus page', () => {
    const slugs = new Set<string>();
    for (const src of ['default', 'work']) for (const f of markdownFiles(join(corpusDir, src))) slugs.add(relative(join(corpusDir, src), f).replace(/\.md$/, ''));
    const dangling: string[] = [];
    for (const f of markdownFiles(corpusDir)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) if (!slugs.has(m[1])) dangling.push(`${relative(corpusDir, f)} -> ${m[1]}`);
    }
    expect(dangling).toEqual([]);
  });

  test('the corpus names only placeholder people and companies', () => {
    const problems = markdownFiles(corpusDir).flatMap(f => placeholderProblems(relative(corpusDir, f), readFileSync(f, 'utf8')));
    expect(problems).toEqual([]);
  });

  test('the placeholder scan finds a real-looking name, company, email and URL (positive control)', () => {
    const text = '[[people/jane-smith]] works at [[companies/bigcorp]]. Alice Smith wrote jane@mail.test, see https://x.test';
    const found = placeholderProblems('default/people/jane-smith.md', text).join('\n');
    expect(found).toContain('person people/jane-smith');
    expect(found).toContain('company companies/bigcorp');
    expect(found).toContain('name Alice Smith');
    expect(found).toContain('email domain mail.test');
    expect(found).toContain('has a URL');
  });

  test('every check that runs has a mechanical expectation, and every not-mechanized check says what it needs', () => {
    for (const s of catalog.scenarios) for (const c of s.checks ?? []) {
      if (c.run) expect(Object.keys(c.expect ?? {}).length).toBeGreaterThan(0);
      else expect((c.requires ?? []).every(r => (CAT9_REQUIREMENTS as readonly string[]).includes(r))).toBe(true);
    }
  });

  test('the audit findings the draft maps to scenarios stay labelled on their checks', () => {
    const findings = new Set(catalog.scenarios.flatMap(s => (s.checks ?? []).map(c => c.known_failure?.finding).filter(Boolean)));
    for (const f of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'RET-05', 'graph-05', 'pages-01 (C1)']) expect(findings.has(f)).toBe(true);
  });
});

const PLACEHOLDER_ORGS = new Set(['companies/fund-a', 'companies/widget-co']);

/** Names in one corpus file that are not placeholders: people/*-example, companies/*-example or a listed org, .example email. */
function placeholderProblems(rel: string, text: string): string[] {
  const problems: string[] = [];
  const slugs = [...text.matchAll(/\[\[([^\]|]+)/g)].map(m => m[1]);
  if (!rel.startsWith('puts/')) slugs.push(rel.replace(/^(default|work)\//, '').replace(/\.md$/, ''));
  for (const s of slugs) {
    if (s.startsWith('people/') && !s.endsWith('-example')) problems.push(`${rel}: person ${s}`);
    if (s.startsWith('companies/') && !s.endsWith('-example') && !PLACEHOLDER_ORGS.has(s)) problems.push(`${rel}: company ${s}`);
  }
  // A capitalised first name the fixture uses, followed by a surname other than "Example".
  for (const m of text.matchAll(/\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g)) if (FIRST_NAMES.has(m[1]) && m[2] !== 'Example') problems.push(`${rel}: name ${m[1]} ${m[2]}`);
  for (const m of text.matchAll(/[\w.+-]+@([\w.-]+)/g)) if (!m[1].endsWith('.example')) problems.push(`${rel}: email domain ${m[1]}`);
  if (/https?:\/\//.test(text)) problems.push(`${rel}: has a URL`);
  return problems;
}

// First names the fixture uses for people; a real-looking surname next to one would be a leak.
const FIRST_NAMES = new Set(['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Olive', 'Pat', 'Quinn', 'Rita', 'Zoe']);

describe('Cat 9 runCat9Checks over the catalog with a stub CLI', () => {
  test('runs only the picked scenarios, writes a table, and refuses unknown ids', () => {
    const { exec } = stubExec(() => ok('[]'));
    const report = runCat9Checks({
      catalog, catalogPath: DEFAULT_CAT9_CATALOG, exec, gbrain: { version: '0.0.0', commit: 'abcdef1234567' },
      only: ['bb9-003-import-builds-links', 'bb9-012-temporal-supersede-hq'],
    });
    expect(report.scenarios.map(s => s.scenario_id)).toEqual(['bb9-003-import-builds-links', 'bb9-012-temporal-supersede-hq']);
    // Stub backlinks returns [] and stats returns [] (no link_count): both N2 checks fail as expected.
    expect(report.scenarios[0].checks.map(c => c.status)).toEqual(['expected_fail', 'expected_fail']);
    expect(report.scenarios[1].status).toBe('no_checks');
    const table = renderChecksTable(report);
    expect(table).toContain('gbrain 0.0.0 (abcdef1234)');
    expect(table).toContain('| bb9-003-import-builds-links | backlinks-after-import | expected_fail | N2 |');
    expect(() => runCat9Checks({ catalog, catalogPath: DEFAULT_CAT9_CATALOG, exec, gbrain: { version: '0', commit: '0' }, only: ['nope'] })).toThrow('unknown scenario id(s): nope');
  });
});

describe('Cat 9 judged path with catalog scenarios', () => {
  test('runCat9 ignores setup and checks and still scores each scenario', async () => {
    const picked = catalog.scenarios.filter(s => s.id === 'bb9-003-import-builds-links' || s.id === 'bb9-014-think-citations');
    const agentClient = {
      messages: { create: async () => ({ content: [{ type: 'text', text: 'Alice and Bob.' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' }) },
    } as unknown as Anthropic;
    const judgeClient = {
      messages: {
        create: async (req: unknown) => {
          const body = JSON.stringify(req);
          const scenario = picked.find(sc => body.includes(sc.id))!;
          const ids = scenario.rubric.map(r => r.id);
          return {
            content: [{ type: 'tool_use', id: 'x', name: 'score_answer', input: { scores: ids.map(id => ({ criterion_id: id, score: 5, rationale: '.' })), verdict: 'pass', overall_rationale: 'ok' } }],
            usage: { input_tokens: 50, output_tokens: 10 },
          };
        },
      },
    } as unknown as Anthropic;
    expect(picked[0].checks!.length).toBeGreaterThan(0);
    const reportsRoot = mkdtempSync(join(tmpdir(), 'cat9-judged-'));
    const report = await runCat9({
      scenarios: picked, state: { engine: {}, poisonFixtures: [] } as any, pagesBySlug: corpusPagesForCatalog(catalog, DEFAULT_CAT9_CATALOG),
      agentClient, judgeClient, concurrency: 1, reportsRoot,
    });
    expect(report.errors).toEqual([]);
    expect(report.scored_scenarios).toBe(2);
    expect(report.overall_pass_rate).toBe(1);
    expect(existsSync(receiptPath('cat9-workflows', reportsRoot))).toBe(true);
    expect(loadReceipt(receiptPath('cat9-workflows', reportsRoot)).n_scored).toBe(2);
    expect(CAT9_CHECKS_CATEGORY).toBe('cat9-workflows-checks');
    // A cold first import of the judged runner took 12 s on one local run; the default 5 s limit is too tight.
  }, 30_000);
});

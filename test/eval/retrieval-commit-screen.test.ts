import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classify, gitEnv, parseArgs, screenCommit } from '../../scripts/retrieval-commit-screen.ts';

const SCRIPT = new URL('../../scripts/retrieval-commit-screen.ts', import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'retrieval-screen-'));
  dirs.push(d);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'commit.gpgsign', 'false');
  return d;
}
// write files and commit them; returns the new commit's sha
function commit(d: string, msg: string, files: Record<string, string>, date = '2026-01-02T03:04:05+05:00'): string {
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(d, dirname(p)), { recursive: true }); writeFileSync(join(d, p), body); }
  git(d, 'add', '--', ...Object.keys(files));
  spawnSync('git', ['-C', d, 'commit', '-q', '-m', msg], { env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(d, 'rev-parse', 'HEAD');
}
const screen = (d: string, sha: string, subject: string, kind = 'gbrain', merge = false) => screenCommit(d, kind, sha, merge, subject);

describe('classify', () => {
  test('first matching rule wins', () => {
    expect(classify('src/core/search/hybrid.ts')?.cls).toBe('strong');
    expect(classify('test/search/hybrid.test.ts')?.cls).toBe('ignore');
    expect(classify('docs/search.md')?.cls).toBe('ignore');
    expect(classify('src/core/postgres-engine.ts')?.cls).toBe('engine');
    expect(classify('src/core/function-search-path.ts')?.area).toBe('engine:shared sql');
    expect(classify('src/core/import-file.ts')?.cls).toBe('context');
    expect(classify('eval/runner/engine-bench/perf.ts')?.cls).toBe('harness');
    for (const f of ['eval/runner/lme-plain-hybrid.ts', 'eval/runner/plain-baseline.ts', 'eval/runner/retrieval-baselines.ts', 'eval/runner/systems/baselines.ts', 'eval/runner/metrics.ts']) expect(classify(f)?.cls).toBe('harness');
    expect(classify('eval/runner/cat11-multimodal.ts')?.cls).toBe('ignore');
    // engine-bench imports these two, so a change there can move its numbers
    for (const f of ['eval/runner/eval-engine.ts', 'eval/runner/gbrain-under-test.ts']) expect(classify(f)).toMatchObject({ cls: 'harness', area: 'shared harness' });
    expect(classify('eval/runner/eval-engine-extra.ts')?.cls).toBe('ignore');
    // a partial clone must not fetch missing blobs on demand (git 2.44 and newer honour this)
    expect(gitEnv().GIT_NO_LAZY_FETCH).toBe('1');
    expect(classify('src/cli.ts')).toBeNull();
  });
});

describe('screenCommit', () => {
  // These tests share one throwaway repository and run in file order; each commit builds on the ones above it.
  const d = repo();
  const base = commit(d, 'seed', { 'package.json': '{\n  "version": "1.0.0",\n  "dependencies": { "a": "1" }\n}\n', 'src/core/postgres-engine.ts': 'export const x = 1;\n', 'src/schema.sql': '-- schema\n' });

  test('a search-path file is yes', () => {
    const sha = commit(d, 'tune ranking', { 'src/core/search/hybrid.ts': 'export const k = 60;\n' });
    expect(screen(d, sha, 'tune ranking')).toMatchObject({ verdict: 'yes', areas: ['search/ranking'] });
  });

  test('docs and tests alone are no', () => {
    const sha = commit(d, 'docs: search guide', { 'docs/search.md': '# search\n', 'test/search.test.ts': 'x\n' });
    expect(screen(d, sha, 'docs: search guide').verdict).toBe('no');
  });

  test('an engine file is maybe, and yes when a changed line is retrieval SQL', () => {
    const plain = commit(d, 'engine tidy', { 'src/core/postgres-engine.ts': 'export const x = 2;\n' });
    expect(screen(d, plain, 'engine tidy')).toMatchObject({ verdict: 'maybe', areas: ['engine:postgres'] });
    const sql = commit(d, 'engine sql', { 'src/core/postgres-engine.ts': 'export const q = `SELECT ts_rank(search_vector, q)`;\n' });
    expect(screen(d, sql, 'engine sql')).toMatchObject({ verdict: 'yes', areas: ['engine:postgres+sql'] });
  });

  test('a comment-only retrieval line does not upgrade', () => {
    commit(d, 'engine reset', { 'src/core/postgres-engine.ts': 'export const q = `SELECT 1`;\n' });
    const sha = commit(d, 'engine comment', { 'src/core/postgres-engine.ts': 'export const q = `SELECT 1`;\n// ts_rank is computed elsewhere\n' });
    expect(screen(d, sha, 'engine comment').verdict).toBe('maybe');
  });

  test('a version-only package.json bump is no; a dependency change is maybe', () => {
    const bump = commit(d, 'release', { 'package.json': '{\n  "version": "1.0.1",\n  "dependencies": { "a": "1" }\n}\n' });
    expect(screen(d, bump, 'release').verdict).toBe('no');
    const dep = commit(d, 'bump a', { 'package.json': '{\n  "version": "1.0.1",\n  "dependencies": { "a": "2" }\n}\n' });
    expect(screen(d, dep, 'bump a')).toMatchObject({ verdict: 'maybe', areas: ['deps'] });
  });

  test('a bun.lock change is maybe, alone or with a version-only package.json bump', () => {
    const lockOnly = commit(d, 'refresh lock', { 'bun.lock': 'lock v1\n' });
    expect(screen(d, lockOnly, 'refresh lock')).toMatchObject({ verdict: 'maybe', areas: ['deps'] });
    const both = commit(d, 'release', { 'package.json': '{\n  "version": "1.0.2",\n  "dependencies": { "a": "2" }\n}\n', 'bun.lock': 'lock v2\n' });
    expect(screen(d, both, 'release')).toMatchObject({ verdict: 'maybe', files: ['bun.lock', 'package.json'] });
  });

  test('known gap: a long schema line that names a search function is a false yes', () => {
    const names = Array.from({ length: 200 }, (_, i) => `fn_${i}`).concat('update_chunk_search_vector').join(', ');
    const sha = commit(d, 'pin function search_path', { 'src/schema.sql': `-- schema\nALTER FUNCTION ${names} SET search_path = public;\n` });
    // Pinned on purpose: scripts/retrieval-commit-screen.md lists this gap. Change this test when the gap is fixed.
    expect(screen(d, sha, 'pin function search_path')).toMatchObject({ verdict: 'yes', areas: ['schema+sql'] });
  });

  test('a subject that names retrieval makes unmapped code maybe', () => {
    const sha = commit(d, 'faster vector query', { 'src/cli.ts': 'export {};\n' });
    expect(screen(d, sha, 'faster vector query')).toMatchObject({ verdict: 'maybe', reason: 'subject names retrieval; code outside mapped paths' });
    const other = commit(d, 'cli tidy', { 'src/cli.ts': 'export const v = 1;\n' });
    expect(screen(d, other, 'cli tidy').verdict).toBe('no');
  });

  test('a deleted engine file is judged on its own removed lines; a SQL comment never upgrades', () => {
    const e = repo();
    commit(e, 'seed', { 'src/core/postgres-engine.ts': 'export const q = `SELECT ts_rank(search_vector, q)`;\n', 'src/core/pglite-engine.ts': 'export const p = 1;\n' });
    git(e, 'rm', '-q', 'src/core/postgres-engine.ts');
    git(e, 'rm', '-q', 'src/core/pglite-engine.ts');
    spawnSync('git', ['-C', e, 'commit', '-q', '-m', 'drop engines'], { env: GIT_ENV });
    expect(screen(e, git(e, 'rev-parse', 'HEAD'), 'drop engines')).toMatchObject({ verdict: 'yes', areas: expect.arrayContaining(['engine:postgres+sql', 'engine:pglite']) });
    const c = commit(e, 'sql comment', { 'src/core/pglite-engine.ts': 'export const p = 2;\n-- tuned for ts_rank later\n' });
    expect(screen(e, c, 'sql comment')).toMatchObject({ verdict: 'maybe', areas: ['engine:pglite'] });
  });

  test('a merge that resolves a conflict with retrieval SQL is yes', () => {
    const m = repo();
    const root = commit(m, 'seed', { 'src/core/postgres-engine.ts': 'export const q = 0;\n' });
    git(m, 'checkout', '-q', '-b', 'left', root);
    commit(m, 'left', { 'src/core/postgres-engine.ts': 'export const q = 1;\n' });
    git(m, 'checkout', '-q', '-b', 'right', root);
    commit(m, 'right', { 'src/core/postgres-engine.ts': 'export const q = 2;\n' });
    spawnSync('git', ['-C', m, 'merge', '-q', 'left'], { env: GIT_ENV });
    writeFileSync(join(m, 'src/core/postgres-engine.ts'), 'export const q = `SELECT ts_rank(search_vector, q)`;\n');
    git(m, 'add', '--', 'src/core/postgres-engine.ts');
    spawnSync('git', ['-C', m, 'commit', '-q', '-m', 'merge left'], { env: GIT_ENV });
    const sha = git(m, 'rev-parse', 'HEAD');
    expect(git(m, 'rev-list', '--parents', '-n1', sha).split(' ').length).toBe(3);
    expect(screen(m, sha, 'merge left', 'gbrain', true)).toMatchObject({ verdict: 'yes', areas: ['engine:postgres+sql'] });
  });

  test('a clean merge is judged on what the merge itself changed', () => {
    git(d, 'checkout', '-q', '-b', 'side', base);
    commit(d, 'side search change', { 'src/core/search/side.ts': 'export const s = 1;\n' });
    git(d, 'checkout', '-q', 'main');
    spawnSync('git', ['-C', d, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], { env: GIT_ENV });
    const sha = git(d, 'rev-parse', 'HEAD');
    expect(git(d, 'rev-list', '--parents', '-n1', sha).split(' ').length).toBe(3);
    expect(screen(d, sha, 'merge side', 'gbrain', true).verdict).toBe('no');
  });
});

describe('screenCommit: names, display settings and manifests', () => {
  test('a file name with a quote or backslash is read as written, in the name list and the patch', () => {
    const e = repo();
    commit(e, 'seed', { 'a.txt': 'a\n' });
    const search = commit(e, 'neutral subject', { 'src/core/search/a"b.ts': 'export const k = 1;\n' });
    expect(screen(e, search, 'neutral subject')).toMatchObject({ verdict: 'yes', files: ['src/core/search/a"b.ts'] });
    const sql = commit(e, 'neutral subject', { 'src/core/engine-sql/we\\ird"name.ts': 'export const q = `SELECT ts_rank(search_vector, q)`;\n' });
    expect(screen(e, sql, 'neutral subject')).toMatchObject({ verdict: 'yes', areas: ['engine:shared sql+sql'] });
  });

  test('user git display settings do not change a verdict', () => {
    const clean = repo();
    const odd = repo();
    git(odd, 'config', 'color.ui', 'always');
    git(odd, 'config', 'diff.noprefix', 'true');
    git(odd, 'config', 'diff.mnemonicPrefix', 'true');
    git(odd, 'config', 'diff.renames', 'false');
    git(odd, 'config', 'log.showSignature', 'true');
    const verdicts = (d: string) => {
      commit(d, 'seed', { 'src/core/postgres-engine.ts': 'export const x = 1;\n', 'package.json': '{\n  "version": "1",\n  "dependencies": { "a": "1" }\n}\n' });
      const sql = commit(d, 'engine sql', { 'src/core/postgres-engine.ts': 'export const q = `SELECT ts_rank(search_vector, q)`;\n' });
      const dep = commit(d, 'bump a', { 'package.json': '{\n  "version": "1",\n  "dependencies": { "a": "2" }\n}\n' });
      return [screen(d, sql, 'engine sql'), screen(d, dep, 'bump a')].map(r => [r.verdict, r.areas]);
    };
    expect(verdicts(odd)).toEqual(verdicts(clean));
    expect(verdicts(clean)).toEqual([['yes', ['engine:postgres+sql']], ['maybe', ['deps']]]);
  });

  test('a one-line package.json dependency change is maybe; a one-line version-only change is no', () => {
    const e = repo();
    commit(e, 'seed', { 'package.json': '{"name":"x","version":"1.0.0","dependencies":{"a":"1"}}\n' });
    const dep = commit(e, 'bump a', { 'package.json': '{"name":"x","version":"1.0.0","dependencies":{"a":"2"}}\n' });
    expect(screen(e, dep, 'bump a')).toMatchObject({ verdict: 'maybe', areas: ['deps'] });
    const bump = commit(e, 'release', { 'package.json': '{"name":"x","version":"1.0.1","dependencies":{"a":"2"}}\n' });
    expect(screen(e, bump, 'release').verdict).toBe('no');
    const reorder = commit(e, 'reorder', { 'package.json': '{"dependencies":{"a":"2"},"version":"1.0.2","name":"x"}\n' });
    expect(screen(e, reorder, 'reorder').verdict).toBe('no');
    // not valid JSON on one side: the changed-line rule decides
    commit(e, 'break', { 'package.json': '{\n  "version": "1.0.3",\n  "dependencies": { "a": "2", }\n}\n' });
    const fall = commit(e, 'bump again', { 'package.json': '{\n  "version": "1.0.3",\n  "dependencies": { "a": "3", }\n}\n' });
    expect(screen(e, fall, 'bump again')).toMatchObject({ verdict: 'maybe', areas: ['deps'] });
  });
});

describe('screenCommit --kind evals', () => {
  const d = repo();
  commit(d, 'seed', { 'package.json': '{\n  "dependencies": { "gbrain": "github:garrytan/gbrain#aaa" }\n}\n', 'eval/runner/engine-bench/perf.ts': 'export const topK = 5;\n' });

  test('a gbrain pin change is yes', () => {
    const sha = commit(d, 'repin', { 'package.json': '{\n  "dependencies": { "gbrain": "github:garrytan/gbrain#bbb" }\n}\n' });
    expect(screen(d, sha, 'repin', 'evals').areas).toContain('gbrain pin');
    expect(screen(d, sha, 'repin', 'evals').verdict).toBe('yes');
  });

  test('a new retrieval baseline runner with a neutral subject is not no', () => {
    const sha = commit(d, 'add a runner', { 'eval/runner/lme-plain-hybrid.ts': 'export const run = () => 1;\n' });
    expect(screen(d, sha, 'add a runner', 'evals').verdict).toBe('maybe');
  });

  test('scorer code under eval/runner/evaluator is harness, not an ignored bench', () => {
    expect(classify('eval/runner/evaluator/reference-scorer.ts')).toMatchObject({ cls: 'harness', area: 'scorers' });
    commit(d, 'scorer seed', { 'eval/runner/evaluator/reference-scorer.ts': 'export const ok = (hits: number) => hits > 0;\n' });
    const sha = commit(d, 'fix recall', { 'eval/runner/evaluator/reference-scorer.ts': 'export const ok = (hits: number) => hits > 1;\n' });
    expect(screen(d, sha, 'fix recall', 'evals')).toMatchObject({ verdict: 'maybe', areas: ['scorers'] });
    expect(screen(d, sha, 'fix recall', 'gbrain').verdict).toBe('no');
  });

  test('a harness line that can move a number is yes; harness files are ignored for gbrain', () => {
    const sha = commit(d, 'bench k', { 'eval/runner/engine-bench/perf.ts': 'export const topK = 10;\n' });
    expect(screen(d, sha, 'bench k', 'evals')).toMatchObject({ verdict: 'yes', areas: ['retrieval bench harness+sql'] });
    expect(screen(d, sha, 'bench k', 'gbrain').verdict).toBe('no');
  });
});

describe('CLI', () => {
  test('prints one table per range with UTC committer dates', () => {
    const d = repo();
    const sha = commit(d, 'tune | ranking', { 'src/core/search/a.ts': 'export {};\n' }, '2026-01-02T03:04:05+05:00');
    const r = spawnSync('bun', [SCRIPT, '--repo', d, '--since', '2025-12-31T00:00:00Z', '--range', 'main=main', '--link', 'https://github.com/example/repo'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('### main');
    expect(r.stdout).toContain('1 commits (0 merges): yes 1, maybe 0, no 0');
    expect(r.stdout).toContain(`[${sha.slice(0, 10)}](https://github.com/example/repo/commit/${sha}) | 2026-01-01 22:04 | tune \\| ranking |`);
  });

  test('exits 2 on missing or malformed options', () => {
    const d = repo();
    commit(d, 'seed', { 'a.txt': 'a\n' });
    const run = (...args: string[]) => spawnSync('bun', [SCRIPT, '--repo', d, '--since', '2025-01-01T00:00:00Z', '--link', 'https://github.com/example/repo', ...args], { encoding: 'utf8' }).status;
    expect(run()).toBe(2);
    expect(run('--range', 'no-equals-sign')).toBe(2);
    expect(run('--range', 'main=main', '--kind', 'other')).toBe(2);
    expect(run('--range', 'main=main', '--kind')).toBe(2);
    expect(run('--range', 'main=main', '--json')).toBe(2);
    expect(run('--range')).toBe(2);
    expect(run('--range', 'main=main', '--kind', '--json', 'x.json')).toBe(2);
    expect(run('--range', 'main=main', '--verbose')).toBe(2);
    expect(run('--range', 'main=main', '--link', 'https://github.com/example/other')).toBe(2);
  });

  test('parseArgs keeps defaults only for absent options', () => {
    const o = parseArgs(['--repo', '.', '--since', '2026-01-01T00:00:00Z', '--link', 'https://x', '--range', 'a=main ^b', '--range', 'c=d']);
    expect(o).toMatchObject({ kind: 'gbrain', json: undefined, ranges: [{ label: 'a', revs: ['main', '^b'] }, { label: 'c', revs: ['d'] }] });
    expect(() => parseArgs(['--repo', '.', '--since', 'yesterday-ish', '--link', 'https://x', '--range', 'a=main'])).toThrow('not an ISO date');
  });

  test('refuses a range token git would read as an option, and a repeated label', () => {
    const base = ['--repo', '.', '--since', '2026-01-01T00:00:00Z', '--link', 'https://x'];
    expect(() => parseArgs([...base, '--range', 'x=--output=/tmp/f master'])).toThrow('would read as an option');
    expect(() => parseArgs([...base, '--range', 'x=-n1'])).toThrow('would read as an option');
    expect(() => parseArgs([...base, '--range', 'a=main', '--range', 'a=other'])).toThrow('used twice');
    expect(parseArgs([...base, '--range', 'a=main ^origin/main']).ranges[0].revs).toEqual(['main', '^origin/main']);
  });

  test('a merge inside the window also screens the older commits it brought in', () => {
    const d = repo();
    const root = commit(d, 'seed', { 'a.txt': 'a\n' }, '2025-12-01T00:00:00Z');
    git(d, 'checkout', '-q', '-b', 'feature', root);
    const old = commit(d, 'old search work', { 'src/core/search/hybrid.ts': 'export const k = 1;\n' }, '2026-01-02T00:00:00Z');
    git(d, 'checkout', '-q', 'main');
    spawnSync('git', ['-C', d, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'], { env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2026-06-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-06-01T00:00:00Z' } });
    const r = spawnSync('bun', [SCRIPT, '--repo', d, '--since', '2026-05-01T00:00:00Z', '--range', 'main=main', '--link', 'https://x'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 commits (1 merges, 1 older than the window, brought in by a merge): yes 1, maybe 0, no 1');
    expect(r.stdout).toContain(`[${old.slice(0, 10)}](https://x/commit/${old}) | 2026-01-02 00:00 | (via merge `);
    expect(r.stdout).toContain('| yes | search/ranking:');
  });

  test('a range labeled __proto__ is a row set like any other, in the report and the JSON', () => {
    const d = repo();
    commit(d, 'tune ranking', { 'src/core/search/a.ts': 'export {};\n' });
    const out = join(d, 'out.json');
    const r = spawnSync('bun', [SCRIPT, '--repo', d, '--since', '2025-01-01T00:00:00Z', '--link', 'https://x', '--range', '__proto__=main', '--range', 'constructor=main', '--json', out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('### __proto__');
    const rows = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(rows)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(rows, '__proto__')?.value[0]).toMatchObject({ verdict: 'yes' });
    expect(rows.constructor).toHaveLength(1);
  });

  test('a missing ref exits 1 with a fix line and no report', () => {
    const d = repo();
    commit(d, 'seed', { 'a.txt': 'a\n' });
    const r = spawnSync('bun', [SCRIPT, '--repo', d, '--since', '2025-01-01T00:00:00Z', '--link', 'https://x', '--range', 'gone=origin/nope'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('retrieval-commit-screen: GIT_FAILED:');
    expect(r.stderr).toContain('fix: check that --repo is a git checkout');
  });

  test('--json writes every row; an unwritable path exits 1 and leaves no partial file', () => {
    const d = repo();
    commit(d, 'tune ranking', { 'src/core/search/a.ts': 'export {};\n' });
    const out = join(d, 'out.json');
    const args = (json: string) => [SCRIPT, '--repo', d, '--since', '2025-01-01T00:00:00Z', '--link', 'https://x', '--range', 'main=main', '--json', json];
    expect(spawnSync('bun', args(out), { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).main[0]).toMatchObject({ verdict: 'yes', files: ['src/core/search/a.ts'] });
    const bad = join(d, 'no-such-dir', 'out.json');
    const r = spawnSync('bun', args(bad), { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('JSON_WRITE_FAILED');
    expect(existsSync(bad)).toBe(false);
    expect(readdirSync(d).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

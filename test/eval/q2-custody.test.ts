import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertCustodyRoots, assertOutsideRepository, custodyTemplatesInput, exportAggregates, gitWorktreeRoot, openCustodyFile,
} from '../../eval/runner/sealed-confirmation-lib.ts';
import { validateGateOutcomes, verdictFromGates, type GateOutcome } from '../../eval/runner/receipt.ts';

const REPO = resolve(import.meta.dir, '../..');
const scratch = () => mkdtempSync(join(tmpdir(), 'q2-custody-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });

/** A scratch git checkout with one commit, plus a linked worktree of it. */
function checkoutWithWorktree(): { main: string; linked: string } {
  const root = scratch();
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(join(main, 'a.txt'), 'a');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'init');
  const linked = join(root, 'linked');
  git(main, 'worktree', 'add', '-q', linked);
  return { main, linked };
}

describe('custody paths outside every git worktree', () => {
  test('a path in this repository, in another checkout or in a linked worktree is refused', () => {
    const { main, linked } = checkoutWithWorktree();
    expect(() => assertOutsideRepository(join(REPO, 'eval/reports/x'), '--output')).toThrow('inside the repository or another git worktree');
    expect(() => assertOutsideRepository(join(main, 'custody/out'), '--output')).toThrow(main);
    expect(gitWorktreeRoot(join(linked, 'deep/not/yet'))).toBe(linked);
    expect(() => assertOutsideRepository(join(linked, 'custody'), '--work')).toThrow('another git worktree');
  });

  test('a symlink from a scratch directory into a worktree is resolved and refused', () => {
    const { linked } = checkoutWithWorktree();
    const s = scratch();
    symlinkSync(linked, join(s, 'looks-outside'));
    expect(() => assertOutsideRepository(join(s, 'looks-outside', 'out'), '--output')).toThrow(linked);
    symlinkSync(REPO, join(s, 'repo-link'));
    expect(() => assertOutsideRepository(join(s, 'repo-link', 'eval'), '--output')).toThrow('inside the repository');
  });

  test('a plain scratch directory passes and is created', () => {
    const s = scratch();
    const roots = assertCustodyRoots({ output: join(s, 'out'), work: join(s, 'work'), needsWork: true });
    expect(existsSync(roots.output)).toBe(true);
    expect(existsSync(roots.work!)).toBe(true);
  });

  test('a sealed run needs explicit output and work roots', () => {
    expect(() => assertCustodyRoots({ output: undefined })).toThrow('explicit --output');
    expect(() => assertCustodyRoots({ output: join(scratch(), 'o'), needsWork: true })).toThrow('explicit --work');
  });

  test('roots are validated before the custody file is read or logged', () => {
    const s = scratch();
    const file = join(s, 'set.json');
    writeFileSync(file, JSON.stringify({ id: 'set', templates: {} }));
    const argv = ['--phrasing-file', file, '--decision-id', 'q2', '--purpose', 'test', '--output', join(REPO, 'eval/reports/q2-leak')];
    expect(() => custodyTemplatesInput(argv, [99], [1])).toThrow('inside the repository');
    expect(existsSync(join(s, 'access-log.jsonl'))).toBe(false);
    expect(() => custodyTemplatesInput([...argv.slice(0, 6), '--output', join(s, 'out')], [99], [1], { needsWork: true })).toThrow('explicit --work');
    expect(existsSync(join(s, 'access-log.jsonl'))).toBe(false);
    const ok = custodyTemplatesInput([...argv.slice(0, 6), '--output', join(s, 'out'), '--work', join(s, 'work')], [99], [1], { needsWork: true })!;
    expect(ok.parsed.id).toBe('set');
    expect(existsSync(join(s, 'access-log.jsonl'))).toBe(true);
  });

  test('a custody file inside a worktree is refused before reading', () => {
    const { linked } = checkoutWithWorktree();
    writeFileSync(join(linked, 'k-pages.jsonl'), '{}');
    expect(() => openCustodyFile({ file: join(linked, 'k-pages.jsonl'), flag: '--k', decisionId: 'q2', purpose: 'x' })).toThrow('another git worktree');
    expect(existsSync(join(linked, 'access-log.jsonl'))).toBe(false);
  });
});

describe('allowlisted aggregate export', () => {
  const receipt = { category: 'q2', run_status: 'completed', data: { summary: { g1: { wrong: 0, list_lines: 512000 }, lines: ['- [Time] - [Event]'] }, rows: [{ line: 'secret text' }] } };
  test('exports only allowlisted paths', () => {
    const { aggregate, exported } = exportAggregates(receipt, ['category', 'data.summary.g1.*']);
    expect(aggregate).toEqual({ category: 'q2', data: { summary: { g1: { wrong: 0, list_lines: 512000 } } } });
    expect(exported).toEqual(['category', 'data.summary.g1.list_lines', 'data.summary.g1.wrong']);
  });
  test('refuses text that is not a short plain identifier, naming the path', () => {
    expect(() => exportAggregates(receipt, ['data.summary.lines'])).toThrow('data.summary.lines.0');
    expect(() => exportAggregates(receipt, ['data.rows.*.line'])).toThrow('data.rows.0.line');
  });
});

describe('gate outcomes apart from execution status', () => {
  const g = (outcome: GateOutcome['outcome'], extra: Partial<GateOutcome> = {}): GateOutcome => ({ gate: 'G', outcome, threshold: 'x = 0', observed: 0, denominators: { planned: 1, attempted: 1, scored: 1, errors: 0 }, ...extra });
  test('only all-pass is pass; fail, insufficient and blocked fail; not run is partial; no gates is partial', () => {
    expect(verdictFromGates([g('pass'), g('pass')])).toBe('pass');
    expect(verdictFromGates([g('pass'), g('insufficient', { failed_threshold: 'n >= 150' })])).toBe('fail');
    expect(verdictFromGates([g('pass'), g('blocked')])).toBe('fail');
    expect(verdictFromGates([g('pass'), g('not_run')])).toBe('partial');
    expect(verdictFromGates([])).toBe('partial');
  });
  test('a failing gate must name the threshold it failed and carry all four denominators', () => {
    expect(validateGateOutcomes([g('fail')])).toEqual(['gates[]: G is fail and must name failed_threshold']);
    expect(validateGateOutcomes([{ ...g('pass'), denominators: { planned: 1 } }])[0]).toContain('denominators');
    expect(validateGateOutcomes([g('fail', { failed_threshold: 'x = 0' })])).toEqual([]);
  });
});

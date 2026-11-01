/**
 * The accepted-drift record (docs/benchmarks/cat40-hard/accepted-drift.json; plan GST-605 Phase 3, unit U8): with
 * --accept-freeze-drift a Hard run starts only when every frozen file that changed since freeze.json has its current
 * hash listed. These tests use a fixture tree, never the repository's own drift, so CI never gates main on it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ACCEPTED_DRIFT_PATH, freezeDrift, loadAcceptedDrift } from '../../eval/runner/cat40/hard-ops.ts';
import { codeHashes, FROZEN_FILES } from '../../eval/runner/cat40/hard.ts';

const tmp = mkdtempSync(join(tmpdir(), 'cat40-accepted-drift-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function fixture(name: string) {
  const root = join(tmp, name);
  for (const f of FROZEN_FILES) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), `// ${f} at the freeze\n`); }
  const freezePath = join(root, 'freeze.json');
  writeFileSync(freezePath, JSON.stringify({ code: codeHashes(root) }));
  const acceptedPath = join(root, 'accepted-drift.json');
  const write = (f: string, content: string) => writeFileSync(join(root, f), content);
  return { paths: { root, freezePath, acceptedPath }, write, accept: (rec: unknown) => writeFileSync(acceptedPath, JSON.stringify(rec)) };
}

describe('freezeDrift with the accepted-drift record', () => {
  const [loop, arms] = ['eval/runner/cat40/loop.ts', 'eval/runner/cat40/arms.ts'];

  test('a listed drift passes, a revert to an earlier listed hash passes, and one changed byte in an unlisted file stops', () => {
    const { paths, write, accept } = fixture('listed');
    write(loop, '// loop.ts with the provider branch\n');
    accept({ [loop]: [{ sha256: sha('// loop.ts at main\n'), date: '2026-10-31', note: 'main' }, { sha256: sha('// loop.ts with the provider branch\n'), date: '2026-10-31', note: 'U8' }] });
    expect(freezeDrift(false, paths)).toEqual([loop]);
    expect(freezeDrift(true, paths)).toEqual([]);
    write(loop, '// loop.ts at main\n');
    expect(freezeDrift(true, paths)).toEqual([]);
    write(arms, `// ${arms} at the freezf\n`);
    expect(freezeDrift(true, paths)).toEqual([arms]);
    write(loop, '// loop.ts with the provider branch, edited again\n');
    expect(freezeDrift(true, paths)).toEqual([loop, arms]);
  });

  test('without the record, the flag accepts nothing; a deleted frozen file is drift too', () => {
    const { paths, write } = fixture('no-record');
    write(loop, '// changed\n');
    expect(freezeDrift(true, paths)).toEqual([loop]);
    rmSync(join(paths.root, arms));
    expect(freezeDrift(true, paths)).toEqual([loop, arms]);
  });

  test('no freeze record, no drift', () => {
    expect(freezeDrift(true, { root: tmp, freezePath: join(tmp, 'absent.json'), acceptedPath: join(tmp, 'absent-too.json') })).toEqual([]);
  });

  test('a malformed record refuses instead of accepting', () => {
    const { paths, write, accept } = fixture('malformed');
    write(loop, '// changed\n');
    for (const bad of [[], { [loop]: [] }, { [loop]: [{ sha256: 'abc', date: '2026-10-31', note: 'x' }] }, { [loop]: [{ sha256: sha('// changed\n'), date: 'yesterday', note: 'x' }] }, { [loop]: [{ sha256: sha('// changed\n'), date: '2026-10-31', note: ' ' }] }]) {
      accept(bad);
      expect(() => freezeDrift(true, paths)).toThrow(/the record is file -> \[\{ sha256, date: YYYY-MM-DD, note \}\]/);
    }
  });

  test('the committed record is well formed, names only frozen files, and each note is in calibration.md', () => {
    const rec = loadAcceptedDrift();
    expect(Object.keys(rec).length).toBeGreaterThan(0);
    for (const f of Object.keys(rec)) expect(FROZEN_FILES).toContain(f);
    const calibration = readFileSync(join(dirname(ACCEPTED_DRIFT_PATH), 'calibration.md'), 'utf8');
    for (const [f, entries] of Object.entries(rec)) for (const e of entries) expect({ f, date: e.date, inCalibration: calibration.includes(e.sha256.slice(0, 12)) }).toEqual({ f, date: e.date, inCalibration: true });
  });
});

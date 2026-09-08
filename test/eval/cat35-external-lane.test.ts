/**
 * Cat 35 external-lane helper tests. Pure, $0, no I/O or network.
 */

import { describe, expect, test } from 'bun:test';
import {
  externalLaneNameError,
  loadExternalLaneDocs,
} from '../../eval/runner/cat35-checks.ts';

const BUILTIN_LANES = ['verbatim', 'facts', 'dream'];

describe('externalLaneNameError', () => {
  test('accepts safe lowercase names', () => {
    for (const name of ['a', 'mytool', 'my-tool-2', `a${'b'.repeat(31)}`]) {
      expect(externalLaneNameError(name, BUILTIN_LANES)).toBeNull();
    }
  });

  test('refuses built-in lane collisions', () => {
    for (const name of BUILTIN_LANES) {
      expect(externalLaneNameError(name, BUILTIN_LANES)).toContain('collides');
    }
  });

  test('refuses unsafe names', () => {
    for (const name of ['', 'Carafe', 'my system', '../x', 'x'.repeat(40), '-lead', '2fast']) {
      expect(externalLaneNameError(name, BUILTIN_LANES)).toContain('must match');
    }
  });
});

describe('loadExternalLaneDocs', () => {
  test('distinguishes present, missing, and empty documents', () => {
    const source = new Map([
      ['one', '# One'],
      ['empty', ''],
    ]);
    const loaded = loadExternalLaneDocs(['one', 'missing', 'empty'], (tid) => source.get(tid) ?? null);

    expect(loaded.docs.get('one')).toBe('# One');
    expect(loaded.docs.has('missing')).toBe(false);
    expect(loaded.docs.has('empty')).toBe(true);
    expect(loaded.docs.get('empty')).toBe('');
    expect(loaded.missing).toEqual(['missing']);
  });

  test('preserves corpus order for documents and missing ids', () => {
    const source = new Map([
      ['third', '3'],
      ['first', '1'],
    ]);
    const loaded = loadExternalLaneDocs(
      ['first', 'missing-a', 'third', 'missing-b'],
      (tid) => source.get(tid) ?? null,
    );

    expect([...loaded.docs.keys()]).toEqual(['first', 'third']);
    expect(loaded.missing).toEqual(['missing-a', 'missing-b']);
  });
});

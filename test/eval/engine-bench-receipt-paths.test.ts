import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MACHINE_LOCAL_PATH, writeScrubbedJson } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CAPY_LOCAL_PATH = /(?:^|[\s"'=(:,\[])(?:\/workspace\/|~\/\.capy\/|\$HOME\/\.capy\/)/;

describe('writeScrubbedJson', () => {
  test('writes engine-bench receipts with no machine-local or Capy scratch path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrubbed-json-'));
    try {
      const home = '/home/runner-x';
      const file = join(dir, 'nested/receipt.json');
      writeScrubbedJson(file, {
        gbrain: { spec: `${home}/.capy/work/gbrain@v0.60.735.0` },
        runners: [{ log: `${home}/.capy/work/correctness/work/n1-pglite.log`, receipt: `${ROOT}/eval/reports/n1.json` }],
        command: `bun eval/runner/engine-bench/perf.ts --gbrain ${home}/gbrain@v0.60.734.0 --out ${tmpdir()}/out`,
        n: 3,
      }, home);
      const text = readFileSync(file, 'utf8');
      expect(JSON.parse(text)).toEqual({
        gbrain: { spec: '<work>/gbrain@v0.60.735.0' },
        runners: [{ log: '<work>/correctness/work/n1-pglite.log', receipt: 'eval/reports/n1.json' }],
        command: 'bun eval/runner/engine-bench/perf.ts --gbrain ~/gbrain@v0.60.734.0 --out <tmp>/out',
        n: 3,
      });
      expect(text.endsWith('}\n')).toBe(true);
      expect(MACHINE_LOCAL_PATH.test(text)).toBe(false);
      expect(CAPY_LOCAL_PATH.test(text)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps checkout paths repo-relative when the checkout sits under the Capy scratch dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrubbed-json-'));
    try {
      const home = '/home/runner-x';
      const root = `${home}/.capy/work/wt`;
      const file = join(dir, 'receipt.json');
      writeScrubbedJson(file, { receipt: `${root}/eval/reports/n1.json`, cwd: root, log: `${home}/.capy/work/n1.log` }, home, root);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ receipt: 'eval/reports/n1.json', cwd: '.', log: '<work>/n1.log' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every engine-bench runner writes its published JSON through it', () => {
    for (const runner of ['correctness', 'lme-recall', 'perf', 'surface-parity']) {
      const src = readFileSync(join(ROOT, `eval/runner/engine-bench/${runner}.ts`), 'utf8');
      expect(src).toContain("import { writeScrubbedJson } from '../receipt.ts';");
      expect(src).toMatch(/writeScrubbedJson\(/);
    }
  });
});

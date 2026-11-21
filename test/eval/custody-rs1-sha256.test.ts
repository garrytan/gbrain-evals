/**
 * RS1 custody scripts on macOS (GST-1886): mint.sh and beam-checkout.sh hash with sha256sum where it exists and fall
 * back to `shasum -a 256`, as on macOS. Each path runs with a PATH that holds only the one tool.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const which = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

describe.each(['mint.sh', 'beam-checkout.sh'])('%s sha256_file', script => {
  const src = readFileSync(join(REPO, 'eval/custody/rs1', script), 'utf8');
  const fn = /^sha256_file\(\) \{[\s\S]*?^\}/m.exec(src)?.[0] ?? '';

  test('every hash in the script goes through sha256_file', () => {
    expect(fn).not.toBe('');
    expect(src.replace(fn, '').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')).not.toMatch(/\bsha256sum\b|\bshasum\b/);
  });

  for (const tool of ['sha256sum', 'shasum']) {
    test(`hashes with ${tool} when it is the only one on PATH`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'rs1-sha-'));
      roots.push(dir);
      mkdirSync(join(dir, 'bin'));
      for (const t of [tool, 'cut']) symlinkSync(which(t), join(dir, 'bin', t));
      const file = join(dir, 'a file');
      writeFileSync(file, 'rs1 portability check\n');
      const env = { PATH: join(dir, 'bin') };
      const r = spawnSync(which('bash'), ['-c', `set -euo pipefail; ${fn}; command -v ${tool === 'shasum' ? 'sha256sum' : 'shasum'} >/dev/null && exit 9; sha256_file "$1"`, 'x', file], { encoding: 'utf8', env });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(createHash('sha256').update(readFileSync(file)).digest('hex') + '\n');
    });
  }
});

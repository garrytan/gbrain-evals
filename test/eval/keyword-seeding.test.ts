import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'keyword-seeding-test-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function runScript(script: string, flag: string) {
  const result = spawnSync(process.execPath, ['--no-env-file', join(root, script), flag], {
    cwd: root,
    encoding: 'utf8',
    timeout: 50_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GBRAIN_HOME: join(home, 'brain'),
      TMPDIR: home,
      GBRAIN_MODEL_DISCOVERY: 'off',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Child exited ${result.status}`);
  return result;
}

test('keyword-only baseline seeding retains the saved retrieval gate without provider credentials', () => {
  const result = runScript('scripts/generate-v0.41-launch.ts', '--check');
  expect(result.stderr).toContain('[gate] PASS');
}, 60_000);

test('identity seeding keeps all documented aliases searchable without provider credentials', () => {
  const result = runScript('eval/runner/identity.ts', '--json');
  const receipt = JSON.parse(result.stdout);
  expect(receipt.results).toHaveLength(800);
  expect(receipt.summary.docRecall).toBe(1);
  expect(receipt.summary.docByType).toEqual({
    fullname: { found: 100, total: 100 },
    handle: { found: 100, total: 100 },
    email: { found: 100, total: 100 },
  });
}, 60_000);

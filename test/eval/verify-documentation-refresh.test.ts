/**
 * scripts/verify-documentation-refresh.py `product_pin_references`: bun.lock and every hub sentence that names the
 * `gbrain` product pin must agree with package.json, and the hubs must name one release. Until 2026-10-31 the verifier
 * checked only the `gbrain-cues` pin, and three hubs kept naming `77cf8e111` through three re-pins (audit item D1).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const HUBS = ['README.md', 'docs/settings.md', 'docs/comparison-systems.md', 'docs/retrieval-lessons.md', 'eval/README.md', 'eval/CONTRIBUTING.md'];
const tmp = mkdtempSync(join(tmpdir(), 'verify-docs-pin-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function references(root: string): Array<string[]> {
  const code = [
    'import importlib.util, json, sys',
    'from pathlib import Path',
    `spec = importlib.util.spec_from_file_location("verify_docs", ${JSON.stringify(join(ROOT, 'scripts/verify-documentation-refresh.py'))})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'print(json.dumps(m.product_pin_references(Path(sys.argv[1]))))',
  ].join('\n');
  const r = Bun.spawnSync(['python3', '-c', code, root], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

/** A copy of the files the check reads, with `edit` applied to one of them. */
function copyWith(name: string, file: string, edit: (text: string) => string): string {
  const root = join(tmp, name);
  for (const f of ['package.json', 'bun.lock', ...HUBS]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(ROOT, f), join(root, f));
  }
  const before = readFileSync(join(root, file), 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`the edit to ${file} changed nothing`);
  writeFileSync(join(root, file), after);
  return root;
}

const sha = /#([a-f0-9]{40})"/.exec(readFileSync(join(ROOT, 'package.json'), 'utf8').match(/"gbrain": "[^"]+"/)![0])![1];

describe('verify-documentation-refresh: the product pin', () => {
  test('the repository passes', () => {
    expect(references(ROOT)).toEqual([]);
  });

  test('a hub that still names an older commit fails, naming the file', () => {
    const root = copyWith('stale-hub', 'eval/README.md', t => t.replace(`master \`${sha.slice(0, 9)}\``, 'master `77cf8e111`'));
    const errors = references(root);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('eval/README.md');
    expect(errors[0][2]).toBe('Product pin reference differs from package.json pin');
  });

  test('a hub sentence reworded out of recognition fails as missing, not as passing', () => {
    const root = copyWith('missing-sentence', 'docs/settings.md', t => t.replace('This page describes the gbrain this repository installs', 'This page describes gbrain'));
    expect(references(root).map(e => [e[0], e[1].split(':')[0]])).toEqual([['docs/settings.md', 'Product pin sentence missing']]);
  });

  test('hubs naming the right commit but different releases fail', () => {
    const root = copyWith('two-releases', 'eval/CONTRIBUTING.md', t => t.replace(/(master `[a-f0-9]+` \(v)[\d.]+/, '$10.60.1.0'));
    const errors = references(root);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toMatch(/^Product pin sentences name different releases: 0\.60\.1\.0, /);
  });

  test('a README link to another commit fails even when the short id matches', () => {
    const root = copyWith('wrong-link', 'README.md', t => t.replace(`gbrain/tree/${sha}`, `gbrain/tree/${sha.slice(0, 9)}${'0'.repeat(31)}`));
    expect(references(root).map(e => e[0])).toEqual(['README.md']);
  });

  test('a lockfile that resolves another commit fails', () => {
    const root = copyWith('stale-lock', 'bun.lock', t => t.replace(`"gbrain": "github:garrytan/gbrain#${sha}"`, `"gbrain": "github:garrytan/gbrain#${'0'.repeat(40)}"`));
    expect(references(root)).toEqual([['bun.lock', 'Declared product pin differs from package.json pin']]);
  });
});

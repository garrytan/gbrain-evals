/**
 * eval/verify/pins.ts tests — fixture-driven, keyless, $0.
 *
 * A synthetic repo with package.json / bun.lock / a workflow / a receipt,
 * mutated one field at a time: non-SHA gbrain dep, lockfile disagreeing,
 * tag-pinned action, bun-version disagreeing, engines comment without an
 * engines field, short receipt SHA. Then the real repo: zero failures.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { checkPins, checkLockfile, checkPackagePin, checkWorkflows, checkReceiptPins } from '../../eval/verify/pins.ts';
import { initRepo, put, commitAll, cleanup, at, severities, runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/pins.ts');
const SHA = '2a56b51236850f6abcbf2f1ea71981bb9630f6fe';

function pkg(dep: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ dependencies: { gbrain: dep }, devDependencies: { '@types/bun': '1.3.10' }, ...extra });
}
function lock(full: string, short: string): string {
  return `{
  "workspaces": { "": { "dependencies": { "gbrain": "github:garrytan/gbrain#${full}" } } },
  "packages": { "gbrain": ["gbrain@github:garrytan/gbrain#${short}", {}, "x", "sha512-abc"] }
}`;
}
function workflow(uses: string, bunVersion = '1.3.10', header = ''): string {
  return `${header}name: ci
jobs:
  x:
    steps:
      - uses: ${uses}
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: ${bunVersion}
`;
}

describe('pins on a synthetic repo', () => {
  let root: string;
  beforeAll(() => {
    root = initRepo('verify-pins');
    put(root, 'package.json', pkg(`github:garrytan/gbrain#${SHA}`));
    put(root, 'bun.lock', lock(SHA, SHA.slice(0, 7)));
    put(root, '.github/workflows/ci.yml', workflow('actions/checkout@11d5960a326750d5838078e36cf38b85af677262'));
    put(root, 'docs/benchmarks/r.json', JSON.stringify({ gbrain_pin: `github:garrytan/gbrain#${SHA}`, gbrain_sha: '079941d2' }));
    commitAll(root);
  });
  afterAll(() => cleanup(root));

  test('the clean fixture has no failures; the short receipt SHA is a warning', () => {
    const r = checkPins({ root });
    expect(severities(r).fail).toBe(0);
    const w = at(r, 'docs/benchmarks/r.json:gbrain_sha', 'warn');
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/short SHA 079941d2/);
    expect(at(r, 'docs/benchmarks/r.json:gbrain_pin')).toEqual([]);
  });

  test('a non-SHA gbrain dependency fails', () => {
    put(root, 'package.json', pkg('github:garrytan/gbrain#main'));
    expect(checkPackagePin(root).findings[0]).toMatchObject({ severity: 'fail' });
    put(root, 'package.json', pkg(`github:garrytan/gbrain#${SHA}`));
  });

  test('a lockfile that names a different SHA, or a non-prefix resolved entry, fails', () => {
    const other = 'a'.repeat(40);
    expect(at({ check: 'x', findings: checkLockfile(root, other) }, 'bun.lock', 'fail')).toHaveLength(2);
    put(root, 'bun.lock', lock(SHA, 'deadbee'));
    const f = checkLockfile(root, SHA);
    expect(f.filter(x => x.severity === 'fail').map(x => x.message).join(' ')).toMatch(/not a prefix/);
    put(root, 'bun.lock', lock(SHA, SHA.slice(0, 7)));
  });

  test('a tag-pinned action fails; a bun-version mismatch warns; an engines comment without engines warns', () => {
    put(root, '.github/workflows/ci.yml', workflow('actions/checkout@v4', '1.2.0', '# bun is pinned to the version in package.json engines\n'));
    const f = checkWorkflows(root);
    expect(f.filter(x => x.severity === 'fail').map(x => x.message).join(' ')).toMatch(/actions\/checkout@v4/);
    const warns = f.filter(x => x.severity === 'warn').map(x => x.message).join(' | ');
    expect(warns).toMatch(/bun-version 1\.2\.0 != package\.json @types\/bun 1\.3\.10/);
    expect(warns).toMatch(/engines/);
    put(root, '.github/workflows/ci.yml', workflow('actions/checkout@11d5960a326750d5838078e36cf38b85af677262'));
  });

  test('engines.bun takes precedence over @types/bun when present', () => {
    put(root, 'package.json', pkg(`github:garrytan/gbrain#${SHA}`, { engines: { bun: '1.3.10' } }));
    const f = checkWorkflows(root);
    expect(f.some(x => x.severity === 'info' && x.message.includes('engines.bun'))).toBe(true);
    put(root, 'package.json', pkg(`github:garrytan/gbrain#${SHA}`));
  });

  test('receipt pins under resolved_config are read too', () => {
    put(root, 'docs/benchmarks/r2.json', JSON.stringify({ resolved_config: { harness_sha: 'not-a-sha' } }));
    const f = checkReceiptPins(root);
    expect(at({ check: 'x', findings: f }, 'r2.json:harness_sha', 'warn')[0].message).toMatch(/not a commit reference/);
  });

  test('CLI exits 0 on the clean fixture and 1 after breaking the dependency pin', () => {
    expect(runCliFile(SCRIPT, ['--root', root, '--quiet']).code).toBe(0);
    put(root, 'package.json', pkg('^1.0.0'));
    expect(runCliFile(SCRIPT, ['--root', root, '--quiet']).code).toBe(1);
    put(root, 'package.json', pkg(`github:garrytan/gbrain#${SHA}`));
  });
});

describe('pins on this repo', () => {
  const report = checkPins();
  test('no failures on main', () => {
    expect(report.findings.filter(f => f.severity === 'fail')).toEqual([]);
  });
  test('package.json and bun.lock agree on the gbrain pin', () => {
    expect(at(report, 'bun.lock', 'info')[0].message).toMatch(/agrees/);
  });
  test('the CI header still cites an engines pin package.json lacks (known)', () => {
    expect(at(report, '.github/workflows/ci.yml', 'warn').some(f => f.message.includes('engines'))).toBe(true);
  });
});

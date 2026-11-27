/**
 * memory-bank's observations configuration (docs/comparison-systems/ext-memory-bank/observations), keyless: the wrapper
 * loads the bundle's shim against stub vendor modules and creates each bank at the server's default, so observations are
 * on, while the bundle's own shim keeps creating retain-only banks. The stack sits in a subdirectory, so the pinned
 * bundle's files and hash (eval/runner/q1/reuse-check.ts BUNDLE_FILES) are untouched, and bootstrap.sh finds it by
 * --config observations. Vendor module names are read from the bundle (eval/runner/name-guard.ts).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUNDLE = 'docs/comparison-systems/ext-memory-bank';
const shim = readFileSync(join(ROOT, BUNDLE, 'shim.py'), 'utf8');
const [, CLIENT_MOD, CLIENT_CLS] = /^from (\w+) import (\w+)\s/m.exec(shim.slice(shim.indexOf('from shim import')))!;
const [, EXC_MOD] = /^from (\w+)\.exceptions import ApiException, NotFoundException/m.exec(shim)!;

/** Create one bank through `script` (the bundle's shim.py or the wrapper) with stub vendor modules; returns the create kwargs, the deviations and health. */
function createBank(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mb-observations-'));
  mkdirSync(join(dir, EXC_MOD));
  writeFileSync(join(dir, `${EXC_MOD}/__init__.py`), '');
  writeFileSync(join(dir, `${EXC_MOD}/exceptions.py`), 'class ApiException(Exception):\n    pass\nclass NotFoundException(ApiException):\n    pass\n');
  writeFileSync(join(dir, `${CLIENT_MOD}.py`), [
    'import json, os',
    `class ${CLIENT_CLS}:`,
    '    def __init__(self, **kw):',
    '        pass',
    '    async def acreate_bank(self, **kw):',
    '        with open(os.environ["CREATE_LOG"], "a") as f:',
    '            f.write(json.dumps(kw) + "\\n")',
  ].join('\n') + '\n');
  const log = join(dir, 'create.ndjson');
  const py = [
    'import importlib.util, json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'eval/systems/_shim'))})`,
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    `spec = importlib.util.spec_from_file_location("target", ${JSON.stringify(join(ROOT, script))})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'cls = getattr(m, "ObservationsAdapter", None) or next(v for k, v in vars(m).items() if k.endswith("Adapter") and k != "Adapter" and isinstance(v, type))',
    'a = cls()',
    'a._run(a._create_bank("ns-1"))',
    'print(json.dumps({"deviations": a.record["deviations_from_vendor_code"], "banks": sorted(a.banks)}))',
  ].join('\n');
  const r = Bun.spawnSync(['python3', '-c', py], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', CREATE_LOG: log, SHIM_CONFIG: 'recipe' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return { kwargs: readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)), ...JSON.parse(r.stdout.toString()) };
}

describe('memory-bank observations configuration', () => {
  test("the wrapper creates each bank at the server's default and says so in the record; the bundle's shim stays retain-only", () => {
    const on = createBank(`${BUNDLE}/observations/observations.py`);
    expect(on.kwargs).toEqual([{ bank_id: 'ns-1' }]);
    expect(on.banks).toEqual(['ns-1']);
    expect(on.deviations.some((d: string) => d.startsWith('Observations on'))).toBe(true);
    expect(on.deviations.some((d: string) => d.startsWith('Observations off'))).toBe(false);
    const off = createBank(`${BUNDLE}/shim.py`);
    expect(off.kwargs).toEqual([{ bank_id: 'ns-1', enable_observations: false }]);
    expect(off.deviations.some((d: string) => d.startsWith('Observations off'))).toBe(true);
  });

  test('the observations stack is the recipe stack with only its shim image swapped', () => {
    const parent = readFileSync(join(ROOT, BUNDLE, 'docker-compose.yml'), 'utf8');
    const child = readFileSync(join(ROOT, BUNDLE, 'observations/docker-compose.yml'), 'utf8');
    const [, envStem] = /env_file: \["(\w+)\.\$\{SHIM_CONFIG:-recipe\}\.env"\]/.exec(parent)!;
    const body = (s: string) => s.slice(s.indexOf('\nname:'))
      .replace(`env_file: ["../${envStem}.recipe.env"]`, `env_file: ["${envStem}.${'$'}{SHIM_CONFIG:-recipe}.env"]`)
      .replace('context: ../../../.., dockerfile: docs/comparison-systems/ext-memory-bank/observations/Dockerfile', 'context: ../../.., dockerfile: docs/comparison-systems/ext-memory-bank/Dockerfile')
      .replace('SHIM_CONFIG: recipe', 'SHIM_CONFIG: ${SHIM_CONFIG:-recipe}');
    expect(body(child)).toBe(body(parent));
  });

  test('bootstrap.sh starts the observations stack for --config observations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mb-obs-boot-'));
    const log = join(dir, 'docker.log');
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "SHIM_CONFIG=$SHIM_CONFIG $*" >> "${log}"\n`);
    chmodSync(join(dir, 'docker'), 0o755);
    const r = Bun.spawnSync(['bash', 'eval/systems/bootstrap.sh', 'down', '--system', 'ext-memory-bank', '--config', 'observations'], { cwd: ROOT, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(`compose -f ${BUNDLE}/observations/docker-compose.yml down -v`);
  });
});

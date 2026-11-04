/**
 * ext-memory-bank's recipe-1.1 configuration: the kind's server at 1.1.0 with its server defaults, built from its own
 * files in docs/comparison-systems/ext-memory-bank/recipe-1.1/ so the pinned 0.10.2 configurations (recipe, common) keep
 * their files and hashes. Keyless: bootstrap.sh runs against a stub docker that records each compose call, and the shim's
 * version check runs against a stub adapter module. The package, service, image and class names are read from the
 * pinned bundle, so no product name appears outside docs/comparison-systems (eval/runner/name-guard.ts).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUNDLE = 'docs/comparison-systems/ext-memory-bank';
const RECIPE = `${BUNDLE}/recipe-1.1`;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
/** The kind's client package (`<lib>-client`) from the pinned 0.10.2 pyproject; `<lib>` also names the server service, the env files, the adapter module and its class. */
const PKG = /dependencies = \["([a-z]+-client)==0\.10\.2"\]/.exec(read(`${BUNDLE}/pyproject.toml`))![1];
const LIB = PKG.replace('-client', '');
const CLS = LIB[0].toUpperCase() + LIB.slice(1);
const ENV = `${LIB.toUpperCase()}_API_`;
const pinnedCompose = Bun.YAML.parse(read(`${BUNDLE}/docker-compose.yml`)) as any;
const compose = Bun.YAML.parse(read(`${RECIPE}/docker-compose.yml`)) as any;
const IMAGE = `${(pinnedCompose.services[LIB].image as string).split(':')[0]}:1.1.0@sha256:50311d02b4d5d2b7c5242bd336edf8735df8374eaad496a92f49c83b37d2aa06`;
const cap = JSON.parse(read(`${RECIPE}/capability.json`));
const relay = (config: string) => `SHIM_CONFIG=${config} PROXY_URL=http://host.docker.internal:8787 PROXY_OPENAI_PATH=/ext-memory-bank/openai/v1`;
const envFile = (p: string) => Object.fromEntries(read(p).split('\n').filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
/** The first \`\`\`json fence after a phrase in the comparison page. */
const fence = (marker: string) => { const t = read('docs/comparison-systems.md'); return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(t.slice(t.indexOf(marker)))![1]); };

/** The pinned 0.10.2 bundle's files at main d2056491 (git show origin/main:<path> | sha256sum). Q1 and the memory proof wave ran these. */
const PINNED_FILES: Record<string, string> = {
  Dockerfile: '9523d3a131219cfed9f064d583bee6cc94a3c93f756503ec51907fa4ddd8be6d',
  'README.md': '9ab925f50165cd8fe2c27acd987bcdb6306f4147b09d1dd7a148e63e7216e8a5',
  'capability.json': '23a033f4b22a8630e7b613172d2b70663613fb65a511c749d720c7ac7938c6fe',
  'docker-compose.yml': '23e8a7ef391cc331f23d53fb26e20c626292815482fe0bcec24d68c495d665f2',
  [`${LIB}.common.env`]: '414029c72d90de494b766a7c3729df49e793571aaefd874b5d63cb625e9759e8',
  [`${LIB}.recipe.env`]: '4ddf1cafee4690a75caa00ab96ff0a01235b0c290c7436ed2c8b2edfe8c57b0c',
  'pyproject.toml': '164f1809e5dfcb7af1d76f86ba9e909d61e553af3d5b3eeafe92bbf2b2393287',
  'shim.py': '47ff0ebd7d860e0732679bdaaacf6886bc420492ea198f269e217e2fa11272de',
  'test_shim.py': 'd5079f10dcd2d91c516961b17d966d47d7be79f3dcde426b52367c6da2b50492',
  'uv.lock': 'f54d89dfad22a2ca6d3ca122f4ae363ed9e06be3a057e5fe02a230d39c16d6d8',
};

/** Run bootstrap.sh with a stub docker on PATH; returns the exit code, stderr and every recorded docker call. */
function bootstrap(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mb-recipe11-'));
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "SHIM_CONFIG=$SHIM_CONFIG PROXY_URL=$PROXY_URL PROXY_OPENAI_PATH=$PROXY_OPENAI_PATH $*" >> "${log}"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const r = Bun.spawnSync(['bash', 'eval/systems/bootstrap.sh', ...args], { cwd: ROOT, env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: string[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { calls = []; }
  return { code: r.exitCode, stderr: r.stderr.toString(), calls };
}

describe('bootstrap.sh --config recipe-1.1', () => {
  test('down and up address the recipe-1.1 compose file with the usual proxy relay settings', () => {
    const down = bootstrap(['down', '--system', 'ext-memory-bank', '--config', 'recipe-1.1']);
    expect(down.code, down.stderr).toBe(0);
    expect(down.calls).toEqual([`${relay('recipe-1.1')} compose -f ${RECIPE}/docker-compose.yml down -v`]);
    const up = bootstrap(['up', '--system', 'ext-memory-bank', '--config', 'recipe-1.1', '--timeout', '1'], { BOOTSTRAP_PROXY_CHECK: 'off' });
    expect(up.calls[0]).toBe(`${relay('recipe-1.1')} compose -f ${RECIPE}/docker-compose.yml up -d`);
  });

  test('recipe and common keep the pinned 0.10.2 stack', () => {
    for (const config of ['recipe', 'common']) {
      expect(bootstrap(['down', '--system', 'ext-memory-bank', '--config', config]).calls).toEqual([`${relay(config)} compose -f ${BUNDLE}/docker-compose.yml down -v`]);
    }
  });
});

describe('recipe-1.1 bundle', () => {
  test('leaves the pinned 0.10.2 bundle byte for byte as main has it', () => {
    const files = readdirSync(join(ROOT, BUNDLE), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
    expect(files).toEqual(Object.keys(PINNED_FILES).sort());
    for (const [name, hash] of Object.entries(PINNED_FILES)) expect(sha256(`${BUNDLE}/${name}`), name).toBe(hash);
    const pinned = fence('machine-readable pin table').find((p: { kind: string }) => p.kind === 'ext-memory-bank');
    expect([pinned.lock_file, pinned.lock_sha256, pinned.capability_sha256]).toEqual([`${BUNDLE}/uv.lock`, PINNED_FILES['uv.lock'], PINNED_FILES['capability.json']]);
  });

  test('pins the server at 1.1.0 by image digest and capability record', () => {
    expect(compose.services[LIB].image).toBe(IMAGE);
    expect(cap.versions.image.startsWith(`${IMAGE} `)).toBe(true);
    expect(cap.versions.server_version).toBe('1.1.0');
    expect(cap.versions.package).toContain(`/${LIB}@a5a619b5ca59c5c39e0f96be6f7a31fabd136bd5, tag v1.1.0, released 2026-10-21) + ${PKG}==1.1.0`);
    expect(cap.versions.latest_release).toStartWith(`${LIB} server 1.2.0 (tag v1.2.0`);
    expect(Object.keys(cap.configs)).toEqual(['recipe-1.1']);
    expect(cap.configs['recipe-1.1'].model_roles.extraction).toBe('gpt-4o-mini');
    expect(cap.configs['recipe-1.1'].model_roles.dims).toBe(384);
  });

  test('pins the client at 1.1.0 by pyproject, lock and image assertion, with the lock inside the vendor-derived constraints', () => {
    const pyproject = read(`${RECIPE}/pyproject.toml`);
    const lock = read(`${RECIPE}/uv.lock`);
    expect(pyproject).toContain(`dependencies = ["${PKG}==1.1.0"]`);
    expect(lock).toContain(`name = "${PKG}"\nversion = "1.1.0"`);
    expect(read(`${RECIPE}/Dockerfile`)).toContain(`m.version('${PKG}') == '1.1.0'`);
    expect(cap.versions.lock_sha256).toBe(sha256(`${RECIPE}/uv.lock`));
    expect(cap.versions.lock_file).toBe(`${RECIPE}/uv.lock`);
    const constraints = Object.fromEntries([...pyproject.split('constraint-dependencies')[1].matchAll(/"([a-z0-9-]+)==([^"]+)"/g)].map(m => [m[1], m[2]]));
    const locked = Object.fromEntries([...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map(m => [m[1], m[2]]));
    const project = /^name = "([^"]+)"/m.exec(pyproject)![1];
    expect(constraints[PKG]).toBe('1.1.0');
    expect(Object.keys(locked).filter(n => n !== project).sort()).toEqual(Object.keys(constraints).sort());
    for (const [name, version] of Object.entries(constraints)) expect(locked[name], name).toBe(version);
  });

  test('the configuration pin table records each own-build configuration by its bundle hashes', () => {
    const pins = fence('configuration pin table') as Array<{ kind: string; config: string; image: string; lock_file: string; lock_sha256: string; capability_sha256: string; license: string; latest_release: string }>;
    expect(pins.map(p => `${p.kind}/${p.config}`)).toEqual(['ext-memory-bank/recipe-1.1', 'ext-temporal-graph/shipped-0.31']);
    for (const p of pins) {
      const dir = `docs/comparison-systems/${p.kind}/${p.config}`;
      expect(existsSync(join(ROOT, dir, 'docker-compose.yml')), dir).toBe(true);
      expect(p.lock_file).toBe(`${dir}/uv.lock`);
      expect(sha256(p.lock_file)).toBe(p.lock_sha256);
      expect(sha256(`${dir}/capability.json`)).toBe(p.capability_sha256);
      const record = JSON.parse(read(`${dir}/capability.json`));
      expect(record.versions.lock_sha256).toBe(p.lock_sha256);
      expect(Object.keys(record.configs)).toEqual([p.config]);
      expect(p.license).toBeTruthy();
    }
    expect(pins[0].image).toBe(IMAGE);
    expect(pins[0].latest_release).toStartWith('1.2.0 (tag v1.2.0');
  });

  test('the recipe env writes out the 1.1.0 defaults: the 0.10.2 recipe unchanged plus every changed default that touches retain or recall', () => {
    expect(compose.services[LIB].env_file).toEqual([`${LIB}.recipe-1.1.env`]);
    const env = envFile(`${RECIPE}/${LIB}.recipe-1.1.env`);
    const pinnedRecipe = envFile(`${BUNDLE}/${LIB}.recipe.env`);
    expect(env).toEqual({
      ...pinnedRecipe,
      [`${ENV}ENTITY_TRGM_SIMILARITY_THRESHOLD`]: '0.3',
      [`${ENV}DECISION_MODEL_PROVIDER`]: 'none',
      [`${ENV}CONSOLIDATION_USE_DECISION_MODEL`]: 'true',
      [`${ENV}RECALL_PREFER_OBSERVATIONS`]: 'false',
    });
    expect(pinnedRecipe[`${ENV}LLM_MODEL`]).toBe('gpt-4o-mini');
  });

  test('compose keeps the pinned network, database and relay, under its own project and volume', () => {
    expect(compose.name).not.toBe(pinnedCompose.name);
    expect(compose.services.db).toEqual(pinnedCompose.services.db);
    expect(compose.services.egress).toEqual(pinnedCompose.services.egress);
    expect(compose.services[LIB].environment).toEqual(pinnedCompose.services[LIB].environment);
    expect(compose.services.shim.environment.SHIM_CONFIG).toBe('${SHIM_CONFIG:-recipe-1.1}');
    expect(compose.services.shim.build.dockerfile).toBe(`${RECIPE}/Dockerfile`);
    for (const s of ['db', LIB, 'shim']) expect(compose.services[s].networks, s).toEqual(['internal']);
    expect(compose.networks.internal.internal).toBe(true);
    expect(compose.volumes).toEqual({ 'db-data': {} });
  });

  test('the image runs the pinned adapter unchanged, and the health check refuses a server that is not 1.1.0', () => {
    const docker = read(`${RECIPE}/Dockerfile`);
    expect(docker).toContain(`COPY ${BUNDLE}/shim.py ./${LIB}_shim.py`);
    expect(docker).toContain('CMD ["/app/venv/bin/python", "shim.py"]');
    expect(read(`${RECIPE}/shim.py`)).toContain(`import ${LIB}_shim as base`);
    const script = [
      'import importlib.util, json, sys, types',
      'class ShimError(Exception):',
      '    def __init__(self, kind, message, status=500):',
      '        super().__init__(message); self.kind, self.status = kind, status',
      'class Base:',
      '    def __init__(self, version): self.record, self.version = json.load(open(sys.argv[2])), version',
      "    def health(self): return {'ok': True, 'server_version': {'api_version': self.version}}",
      `m = types.ModuleType('${LIB}_shim'); m.__dict__.update(${CLS}Adapter=Base, ShimError=ShimError, CONFIG='recipe-1.1', serve=None); sys.modules['${LIB}_shim'] = m`,
      "spec = importlib.util.spec_from_file_location('recipe_shim', sys.argv[1]); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      'out = []',
      "for v in ('1.1.0', '1.2.0', None):",
      '    try: out.append(mod.Recipe11Adapter(v).health()["server_version"]["api_version"])',
      '    except ShimError as e: out.append([e.kind, e.status])',
      'print(json.dumps(out))',
    ].join('\n');
    const r = Bun.spawnSync(['python3', '-c', script, join(ROOT, RECIPE, 'shim.py'), join(ROOT, RECIPE, 'capability.json')], { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual(['1.1.0', ['product_error', 503], ['product_error', 503]]);
  });
});

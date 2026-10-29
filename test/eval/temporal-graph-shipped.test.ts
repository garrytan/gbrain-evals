/**
 * ext-temporal-graph's shipped-0.31 configuration: the kind's package at 0.31.2 with its shipped defaults, built from its own
 * files in docs/comparison-systems/ext-temporal-graph/shipped-0.31/ so the pinned 0.30.2 configurations (recipe,
 * common) keep their files and hashes. Keyless: bootstrap.sh runs against a stub docker that records each compose call,
 * and the shim's model check runs against stub package modules. The package, module and class names are read from the
 * pinned bundle, so no product name appears outside docs/comparison-systems (eval/runner/name-guard.ts).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUNDLE = 'docs/comparison-systems/ext-temporal-graph';
const SHIPPED = `${BUNDLE}/shipped-0.31`;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The kind's package (`<lib>-core`), its module (`<lib>_core`) and its client class, from the pinned 0.30.2 pyproject. */
const PKG = /dependencies = \["([a-z]+-core)==0\.30\.2"\]/.exec(read(`${BUNDLE}/pyproject.toml`))![1];
const MOD = PKG.replace('-', '_');
const LIB = PKG.replace('-core', '');
const CLS = LIB[0].toUpperCase() + LIB.slice(1);
const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
const relay = (config: string) => `SHIM_CONFIG=${config} PROXY_URL=http://host.docker.internal:8787 PROXY_OPENAI_PATH=/ext-temporal-graph/openai/v1`;

/** Run bootstrap.sh with a stub docker on PATH; returns the exit code, stderr and every recorded docker call. */
function bootstrap(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shipped-'));
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "SHIM_CONFIG=$SHIM_CONFIG PROXY_URL=$PROXY_URL PROXY_OPENAI_PATH=$PROXY_OPENAI_PATH $*" >> "${log}"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const r = Bun.spawnSync(['bash', 'eval/systems/bootstrap.sh', ...args], { cwd: ROOT, env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: string[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { calls = []; }
  return { code: r.exitCode, stderr: r.stderr.toString(), calls };
}

describe('bootstrap.sh --config shipped-0.31', () => {
  test('selects the shipped-0.31 stack for ext-temporal-graph with the usual proxy relay settings', () => {
    const r = bootstrap(['down', '--system', 'ext-temporal-graph', '--config', 'shipped-0.31']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls).toEqual([`${relay('shipped-0.31')} compose -f ${SHIPPED}/docker-compose.yml down -v`]);
  });

  test('setup, up and restart address the shipped-0.31 compose file', () => {
    expect(bootstrap(['up', '--system', 'ext-temporal-graph', '--config', 'shipped-0.31', '--timeout', '1'], { BOOTSTRAP_PROXY_CHECK: 'off' }).calls[0]).toBe(`${relay('shipped-0.31')} compose -f ${SHIPPED}/docker-compose.yml up -d`);
    expect(bootstrap(['restart', '--system', 'ext-temporal-graph', '--config', 'shipped-0.31', '--timeout', '1']).calls[0]).toBe(`${relay('shipped-0.31')} compose -f ${SHIPPED}/docker-compose.yml restart`);
    const setup = bootstrap(['setup', '--system', 'ext-temporal-graph', '--config', 'shipped-0.31']).calls.filter(c => c.includes(' compose '));
    expect(setup).toEqual([
      `${relay('shipped-0.31')} compose -f ${SHIPPED}/docker-compose.yml pull --ignore-buildable --quiet`,
      `${relay('shipped-0.31')} compose -f ${SHIPPED}/docker-compose.yml build --quiet`,
    ]);
  }, 120_000);

  test('recipe and common keep the pinned stack, and other systems ignore a configuration directory they do not have', () => {
    for (const config of ['recipe', 'common']) {
      expect(bootstrap(['down', '--system', 'ext-temporal-graph', '--config', config]).calls).toEqual([`${relay(config)} compose -f ${BUNDLE}/docker-compose.yml down -v`]);
    }
    expect(bootstrap(['down', '--system', 'ext-temporal-graph']).calls).toEqual([`${relay('recipe')} compose -f ${BUNDLE}/docker-compose.yml down -v`]);
    expect(bootstrap(['down', '--system', 'ext-memory-bank', '--config', 'shipped-0.31']).calls[0]).toContain('compose -f docs/comparison-systems/ext-memory-bank/docker-compose.yml down -v');
    expect(bootstrap(['down', '--system', '_fake', '--config', 'common']).calls[0]).toContain('compose -f eval/systems/_fake/docker-compose.yml down -v');
  });

  test('refuses a configuration name that could leave the bundle', () => {
    for (const config of ['../ext-memory-bank', '.', 'a/b', '']) {
      const r = bootstrap(['down', '--system', 'ext-temporal-graph', '--config', config]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('--config must be a configuration name');
      expect(r.calls).toEqual([]);
    }
  });
});

describe('shipped-0.31 bundle', () => {
  const cap = JSON.parse(read(`${SHIPPED}/capability.json`));

  test('leaves the pinned 0.30.2 files as Q1 recorded them', () => {
    const pinned = JSON.parse(read(`${BUNDLE}/capability.json`));
    expect(Object.keys(pinned.configs)).toEqual(['recipe', 'common']);
    expect(sha256(`${BUNDLE}/uv.lock`)).toBe(pinned.versions.lock_sha256);
    expect(read(`${BUNDLE}/pyproject.toml`)).toContain(`dependencies = ["${PKG}==0.30.2"]`);
    expect(read(`${BUNDLE}/Dockerfile`)).toContain(`m.version('${PKG}') == '0.30.2'`);
  });

  test('pins the package at 0.31.2 by lock, image assertion and capability record', () => {
    expect(read(`${SHIPPED}/pyproject.toml`)).toContain(`dependencies = ["${PKG}==0.31.2"]`);
    expect(read(`${SHIPPED}/uv.lock`)).toContain(`name = "${PKG}"\nversion = "0.31.2"`);
    expect(read(`${SHIPPED}/Dockerfile`)).toContain(`m.version('${PKG}') == '0.31.2'`);
    expect(cap.versions.lock_sha256).toBe(sha256(`${SHIPPED}/uv.lock`));
    expect(cap.versions.package).toContain(`${PKG}==0.31.2 (`);
    expect(cap.versions.package).toContain(`/${LIB}@d72407dcedac911e1be9fc15b55e8c05a3efcc36, tag v0.31.2`);
    expect(Object.keys(cap.configs)).toEqual(['shipped-0.31']);
    expect(cap.configs['shipped-0.31'].model_roles).toEqual({ extraction: 'gpt-6-luna', small: 'gpt-6-luna', embedder: 'text-embedding-3-small', dims: 1024, reranker: 'gpt-4.1-mini' });
  });

  test('the image runs the pinned adapter unchanged and builds the client with no model clients', () => {
    const docker = read(`${SHIPPED}/Dockerfile`);
    expect(docker).toContain(`COPY docs/comparison-systems/ext-temporal-graph/shim.py ./${LIB}_shim.py`);
    expect(docker).toContain('CMD ["/app/venv/bin/python", "shipped.py"]');
    const shim = read(`${SHIPPED}/shipped.py`);
    expect(shim).toMatch(new RegExp(`${LIB} = ${CLS}\\(`));
    expect(shim).toMatch(/ = \w+\(os\.environ\.get\("NEO4J_URI", "bolt:\/\/neo4j:7687"\), os\.environ\.get\("NEO4J_USER", "neo4j"\),\s+os\.environ\["NEO4J_PASSWORD"\]\)\n/);
    expect(shim).not.toMatch(/llm_client=|embedder=|cross_encoder=|llm_runtime=|prompt_library=/);
  });

  test('compose routes every provider call through the egress relay, leaves EMBEDDING_DIM unset and keeps its own volumes', () => {
    const compose = Bun.YAML.parse(read(`${SHIPPED}/docker-compose.yml`)) as any;
    const pinned = Bun.YAML.parse(read(`${BUNDLE}/docker-compose.yml`)) as any;
    expect(compose.name).not.toBe(pinned.name);
    expect(compose.services.shim.environment.OPENAI_BASE_URL).toBe('http://egress:9000${PROXY_OPENAI_PATH:-/openai/v1}');
    expect(compose.services.shim.environment.SHIM_CONFIG).toBe('${SHIM_CONFIG:-shipped-0.31}');
    expect(compose.services.shim.environment).not.toHaveProperty('EMBEDDING_DIM');
    expect(compose.services.shim.networks).toEqual(['internal']);
    expect(compose.services.neo4j.networks).toEqual(['internal']);
    expect(compose.networks.internal.internal).toBe(true);
    expect(compose.services.neo4j.image).toBe(pinned.services.neo4j.image);
    expect(compose.services.neo4j.volumes).toEqual(['neo4j-data:/data', 'neo4j-logs:/logs']);
    expect(compose.services.egress).toEqual(pinned.services.egress);
    expect(compose.services.shim.build.dockerfile).toBe(`${SHIPPED}/Dockerfile`);
  });

  test('the model check reads the roles the package resolved, so a drifted default would not match the record', () => {
    const script = [
      "import json, sys, types",
      "def mod(name, **kw):",
      "    m = types.ModuleType(name); m.__dict__.update(kw); sys.modules[name] = m; return m",
      "class Base: pass",
      `mod('${LIB}_shim', ${CLS}Adapter=Base, CONFIG='shipped-0.31', serve=None)`,
      `mod('${MOD}', ${CLS}=object); mod('${MOD}.cross_encoder'); mod('${MOD}.llm_client')`,
      `mod('${MOD}.cross_encoder.openai_reranker_client', DEFAULT_MODEL='gpt-4.1-mini')`,
      `mod('${MOD}.llm_client.openai_base_client', DEFAULT_MODEL='gpt-6-luna', DEFAULT_SMALL_MODEL='gpt-6-luna')`,
      "sys.path.insert(0, sys.argv[1])",
      "import shipped",
      "ns = types.SimpleNamespace",
      "def g(model=None, small=None, emb='text-embedding-3-small', dims=1024, rr=None):",
      "    return ns(llm_client=ns(model=model, small_model=small), embedder=ns(config=ns(embedding_model=emb, embedding_dim=dims)), cross_encoder=ns(config=ns(model=rr)))",
      "print(json.dumps([shipped.resolved_roles(g()), shipped.resolved_roles(g(dims=1536, rr='gpt-4.1-nano'))]))",
    ].join('\n');
    const r = Bun.spawnSync(['python3', '-c', script, join(ROOT, SHIPPED)], { cwd: ROOT });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const [defaults, drifted] = JSON.parse(r.stdout.toString());
    expect(defaults).toEqual(cap.configs['shipped-0.31'].model_roles);
    expect(drifted).not.toEqual(cap.configs['shipped-0.31'].model_roles);
  });
});

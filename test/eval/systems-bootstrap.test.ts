/**
 * eval/systems/bootstrap.sh, the VM bootstrap a counted cell uses. Always: the script parses and documents itself.
 * With SHOOTOUT_DOCKER_TESTS=1 (needs Docker): start a lease proxy, bring up the keyless reference stack
 * (eval/systems/_fake/docker-compose.yml) through it, run the shared protocol check, prove the shim reaches the
 * proxy through its egress relay and nothing else, and tear down. Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const sh = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(['bash', 'eval/systems/bootstrap.sh', ...args], { cwd: ROOT, env: { ...process.env, ...env } });

describe('bootstrap.sh', () => {
  test('parses, and prints its usage for an unknown subcommand', () => {
    expect(Bun.spawnSync(['bash', '-n', 'eval/systems/bootstrap.sh'], { cwd: ROOT }).exitCode).toBe(0);
    const r = sh(['help']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('setup  [--system NAME]');
    expect(sh(['up']).stderr.toString()).toContain('--system is required');
    expect(sh(['up', '--system', 'no-such-system']).stderr.toString()).toContain('no compose file');
    expect(r.stderr.toString()).toContain('restart --system NAME');
    expect(sh(['restart']).stderr.toString()).toContain('--system is required');
  });

  test.skipIf(process.env.SHOOTOUT_DOCKER_TESTS !== '1')('brings the keyless reference stack up behind a lease proxy', () => {
    const out = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    const free = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return String(p); };
    const proxyPort = free(), shimPort = free();
    expect(sh(['proxy', '--lease-id', 'bootstrap-test', '--lease-usd', '0.01', '--port', proxyPort, '--out', join(out, 'proxy')]).exitCode).toBe(0);
    try {
      const up = sh(['up', '--system', '_fake', '--config', 'common', '--port', shimPort, '--proxy-port', proxyPort, '--timeout', '300']);
      expect(up.exitCode, up.stderr.toString()).toBe(0);
      const check = Bun.spawnSync(['python3', 'eval/systems/_shim/protocol_check.py', '--url', `http://127.0.0.1:${shimPort}`], { cwd: ROOT });
      expect(check.exitCode, check.stdout.toString()).toBe(0);
      const exec = (code: string) => Bun.spawnSync(['docker', 'compose', '-f', 'eval/systems/_fake/docker-compose.yml', 'exec', '-T', 'shim', 'python', '-c', code], { cwd: ROOT, env: { ...process.env, SHIM_HOST_PORT: shimPort, PROXY_UPSTREAM: `host.docker.internal:${proxyPort}` } });
      expect(exec("import urllib.request; print(urllib.request.urlopen('http://egress:8787/__proxy/status', timeout=5).read().decode())").stdout.toString()).toContain('"run_id":"bootstrap-test"');
      expect(exec("import urllib.request; urllib.request.urlopen('https://api.openai.com', timeout=5)").exitCode).not.toBe(0);
      const out2 = join(out, 'lifecycle-lite');
      const restartCmd = `bash eval/systems/bootstrap.sh restart --system _fake --port ${shimPort} --proxy-port ${proxyPort} --timeout 300`;
      const lite = Bun.spawnSync([process.execPath, 'eval/runner/lifecycle-lite.ts', '--system', `http://127.0.0.1:${shimPort}`, '--seeds', '1', '--restart', '--restart-cmd', restartCmd, '--output', out2], { cwd: ROOT });
      expect(lite.exitCode, lite.stderr.toString().slice(-2000)).toBe(0);
      const receipt = JSON.parse(readFileSync(join(out2, 'receipt.json'), 'utf8'));
      expect([receipt.run_status, receipt.checks.restart, receipt.metrics.restart.lost, receipt.checks.forget]).toEqual(['complete', 'pass', 0, 'pass']);
    } finally {
      sh(['down', '--system', '_fake', '--port', shimPort]);
      Bun.spawnSync(['kill', readFileSync(join(out, 'proxy', 'proxy.pid'), 'utf8').trim()]);
    }
  }, 600_000);
});

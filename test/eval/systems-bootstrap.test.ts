/**
 * eval/systems/bootstrap.sh, the VM bootstrap a counted cell uses. Always: the script parses and documents itself.
 * With SHOOTOUT_DOCKER_TESTS=1 (needs Docker): start a lease proxy, bring up the keyless reference stack
 * (eval/systems/_fake/docker-compose.yml) through it, run the shared protocol check, prove the shim reaches the
 * proxy through its egress relay and nothing else, and tear down; snapshot the stack's named volumes into a tar with
 * its sha256, remove the stack, restore it from the tar and read the same data back, and refuse a damaged snapshot.
 * Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(r.stderr.toString()).toContain('snapshot --system NAME --out TAR');
    expect(r.stderr.toString()).toContain('restore --system NAME --from TAR');
    expect(sh(['snapshot', '--system', '_fake']).stderr.toString()).toContain('snapshot needs --out');
    expect(sh(['restore', '--system', '_fake', '--from', '/no/such.tar']).stderr.toString()).toContain('restore needs --from');
  });

  test.skipIf(process.env.SHOOTOUT_DOCKER_TESTS !== '1')('snapshot tars the stopped stack\'s named volumes with a sha256; restore brings them back into a fresh stack', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bootstrap-snap-'));
    const free = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return String(p); };
    const proxyPort = free(), shimPort = free();
    const base = `http://127.0.0.1:${shimPort}`;
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
    const ns = 'ns-00000000000000f1', src = 'src-00000000000000f1';
    const tar = join(out, 'snap', '_fake.tar');
    expect(sh(['proxy', '--lease-id', 'bootstrap-snap', '--lease-usd', '0.01', '--port', proxyPort, '--out', join(out, 'proxy')]).exitCode).toBe(0);
    try {
      expect(sh(['up', '--system', '_fake', '--port', shimPort, '--proxy-port', proxyPort, '--timeout', '300']).exitCode).toBe(0);
      await post('/reset', { ns });
      await post('/ingest', { ns, session: { source_id: src, event_time: '2026-01-02T00:00:00Z', turns: [{ role: 'user', speaker: 'User', content: 'the zephyrquokka lives in the attic' }] } });
      const before = await post('/retrieve', { ns, question: 'where does the zephyrquokka live?', query_time: null, policy: { name: 'p', mode: 'fixed-evidence', settings: {} } });
      expect(before.items.map((i: any) => i.source_ids).flat()).toContain(src);

      const snap = sh(['snapshot', '--system', '_fake', '--port', shimPort, '--out', tar, '--timeout', '300']);
      expect(snap.exitCode, snap.stderr.toString()).toBe(0);
      const sha = readFileSync(`${tar}.sha256`, 'utf8').trim();
      expect(sha).toBe(createHash('sha256').update(readFileSync(tar)).digest('hex'));
      const listing = Bun.spawnSync(['tar', '-tf', tar]).stdout.toString();
      expect(listing).toContain('./volumes.json');
      expect(listing).toContain('./fake-data.tar');
      expect((await (await fetch(`${base}/health`)).json() as any).ok).toBe(true);

      expect(sh(['down', '--system', '_fake', '--port', shimPort]).exitCode).toBe(0);
      const restored = sh(['restore', '--system', '_fake', '--port', shimPort, '--from', tar, '--timeout', '300']);
      expect(restored.exitCode, restored.stderr.toString()).toBe(0);
      const after = await post('/retrieve', { ns, question: 'where does the zephyrquokka live?', query_time: null, policy: { name: 'p', mode: 'fixed-evidence', settings: {} } });
      expect(after.items.map((i: any) => i.source_ids).flat()).toContain(src);

      writeFileSync(`${tar}.sha256`, '0'.repeat(64) + '\n');
      const damaged = sh(['restore', '--system', '_fake', '--port', shimPort, '--from', tar]);
      expect(damaged.exitCode).not.toBe(0);
      expect(damaged.stderr.toString()).toContain('does not match');
    } finally {
      sh(['down', '--system', '_fake', '--port', shimPort]);
      Bun.spawnSync(['kill', readFileSync(join(out, 'proxy', 'proxy.pid'), 'utf8').trim()]);
    }
  }, 600_000);

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
    } finally {
      sh(['down', '--system', '_fake', '--port', shimPort]);
      Bun.spawnSync(['kill', readFileSync(join(out, 'proxy', 'proxy.pid'), 'utf8').trim()]);
    }
  }, 600_000);
});

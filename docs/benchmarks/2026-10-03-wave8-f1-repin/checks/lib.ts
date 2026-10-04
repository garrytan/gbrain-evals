// Shared helpers for the wave 8 / Foundations 1 checks: which gbrain to run, a keyless environment and a CLI runner.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../../..');
/** The gbrain under test: GBRAIN_ROOT (a checkout with node_modules) or the pinned dependency. */
export const GBRAIN_ROOT = process.env.GBRAIN_ROOT ? resolve(process.env.GBRAIN_ROOT) : join(REPO, 'node_modules/gbrain');
export const GBRAIN_VERSION: string = JSON.parse(readFileSync(join(GBRAIN_ROOT, 'package.json'), 'utf8')).version;
export const src = (p: string) => join(GBRAIN_ROOT, 'src', p);

const KEY = /(_API_KEY|_API_TOKEN|_BEARER_TOKEN|_BASE_URL)$|^(TYPESAFE|JEV)_|^GBRAIN_/;

/** A fresh GBRAIN_HOME and an environment with every provider key, endpoint and GBRAIN_* setting removed. */
export function keylessHome(extra: Record<string, string> = {}): { home: string; env: Record<string, string>; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'w8f1-home-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !KEY.test(k)) env[k] = v;
  Object.assign(env, { GBRAIN_HOME: home, NO_COLOR: '1' }, extra);
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export interface CliResult { code: number; stdout: string; stderr: string }

/** Run `gbrain <args>` from the gbrain under test as a subprocess. Async, so an in-process fake provider keeps answering. */
export async function gbrain(args: string[], env: Record<string, string>, cwd = REPO, stdin?: string): Promise<CliResult> {
  if (process.env.W8F1_TRACE) console.error(`[trace] gbrain ${args.join(' ')}`);
  const proc = Bun.spawn([process.execPath, join(GBRAIN_ROOT, 'src/cli.ts'), ...args], { env, cwd, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 300_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Print one JSON result line and exit 0 when every check holds, else 1. */
export function finish(name: string, checks: Record<string, boolean>, observed: Record<string, unknown>): never {
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(JSON.stringify({ check: name, gbrain_version: GBRAIN_VERSION, pass: failed.length === 0, failed, checks, observed }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

/** A minimal MCP client for `gbrain serve` over stdio (newline-delimited JSON-RPC); stdio callers are remote to gbrain. */
export async function mcpSession(env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn([process.execPath, join(GBRAIN_ROOT, 'src/cli.ts'), 'serve'], { env, cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map<number, (m: any) => void>();
  let id = 1;
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch { /* not JSON-RPC */ }
      }
    }
  })();
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolveReq, reject) => {
    const n = id++;
    const t = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 180_000);
    pending.set(n, m => { clearTimeout(t); resolveReq(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-w8f1', version: '1' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    request,
    async tools(): Promise<Array<{ name: string }>> { return (await request('tools/list', {})).result?.tools ?? []; },
    async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; raw: any }> {
      const m = await request('tools/call', { name, arguments: args });
      if (m.error) return { isError: true, text: JSON.stringify(m.error), raw: m };
      const text = (m.result?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      return { isError: !!m.result?.isError, text, raw: m };
    },
    async close() { proc.stdin.end(); const t = setTimeout(() => proc.kill('SIGKILL'), 10_000); await proc.exited; clearTimeout(t); },
  };
}

/**
 * The pinned comparator server's LLM traffic is metered: at zero balance the
 * metering proxy refuses its extraction call and nothing reaches the stub
 * upstream; with budget the call reaches the stub and settles.
 *
 * Needs the harness venv and the installed comparator server
 * (`bun run harness:comparator install`); skipped otherwise unless
 * MPW_REQUIRE_HARNESS=1, which makes a missing install a failure.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertZeroBalanceBlocks } from '../../eval/runner/metering-proxy-testkit.ts';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, type HarnessInstall } from '../../eval/runner/harness-env.ts';

const REPO = resolve(import.meta.dir, '../..');

function comparatorInstall(): { install: HarnessInstall | null; skip: string | null } {
  try {
    const install = ensureHarness({ checkOnly: true, log: () => {} });
    const check = Bun.spawnSync([install.python, '-m', 'mpw.comparator_server', 'check'], { cwd: PROVIDER_DIR, env: harnessProcessEnv(install, { MPW_REPO_ROOT: REPO }), stdout: 'pipe', stderr: 'pipe' });
    if (check.exitCode !== 0) return { install: null, skip: check.stderr.toString().trim().split('\n').at(-1) ?? 'comparator server not installed' };
    return { install, skip: null };
  } catch (error) {
    return { install: null, skip: (error as Error).message };
  }
}

describe('comparator server metering', () => {
  const { install, skip } = comparatorInstall();
  const require = process.env.MPW_REQUIRE_HARNESS === '1';
  if (!install && !require) console.warn(`[comparator-server.test] skipping: ${skip}. Run \`bun run harness:comparator install\`, or set MPW_REQUIRE_HARNESS=1 to make this a failure.`);

  test.skipIf(!install && !require)('zero balance blocks the comparator process; with budget its extraction call settles', async () => {
    if (!install) throw new Error(`MPW_REQUIRE_HARNESS=1 but the comparator server is not installed: ${skip}`);
    const outcomes: Array<{ status: number; body: string; left_running: number[] }> = [];
    const { zero, positive } = await assertZeroBalanceBlocks<Record<string, string>>({
      label: 'comparator',
      timeoutMs: 120_000,
      spawn: async env => env,
      trigger: async env => {
        const dataDir = mkdtempSync(join(tmpdir(), 'comparator-probe-'));
        try {
          const proc = Bun.spawn([install.python, join(PROVIDER_DIR, 'tests/comparator_probe.py'), dataDir], {
            cwd: PROVIDER_DIR, env: harnessProcessEnv(install, { MPW_REPO_ROOT: REPO, MPW_CHILD_ENV_COMPARATOR: JSON.stringify(env) }), stdout: 'pipe', stderr: 'pipe',
          });
          const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
          if (proc.exitCode !== 0) throw new Error(`comparator_probe.py exited ${proc.exitCode}: ${err.slice(-2000)}`);
          outcomes.push(JSON.parse(out.trim().split('\n').at(-1)!));
        } finally {
          rmSync(dataDir, { recursive: true, force: true });
        }
      },
    });
    const [blocked, allowed] = outcomes;
    expect(blocked.status).not.toBe(200);
    expect(allowed.status).toBe(200);
    expect(blocked.left_running).toEqual([]);
    expect(allowed.left_running).toEqual([]);
    expect(zero.refused).toBeGreaterThan(0);
    expect(new Set(zero.log.map(l => l.provider))).toEqual(new Set(['openai']));
    expect(positive.settled).toBeGreaterThan(0);
  }, 600_000);
});

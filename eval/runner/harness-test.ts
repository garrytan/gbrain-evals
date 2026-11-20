/**
 * Run the Python tests for eval/harness-provider/ inside the pinned harness
 * venv (installing it first if needed). Extra arguments go to pytest.
 *
 *   bun run harness:test [-- -k name]
 *   bun run harness:test --junit-dir=<dir> [pytest args]
 *
 * With --junit-dir, as CI runs it, the suite runs as three pytest processes at
 * once: the two slowest files (about 2.5 minutes each, mostly waiting on the
 * gbrain and comparator processes they start) each alone, and every other file
 * together. Each writes an xunit1 JUnit report, pytest-<n>.xml, for CI's
 * tested-tree record, and prints its lines as they arrive led by its group
 * number. The run fails if any group fails or writes no report.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR } from './harness-env.ts';

export const SLOW_FILES = ['tests/test_gbrain_provider.py', 'tests/test_comparator_server.py'];
export const GROUPS: string[][] = [...SLOW_FILES.map(f => [f]), ['tests', ...SLOW_FILES.map(f => `--ignore=${f}`)]];

async function lines(from: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const decoder = new TextDecoder();
  let partial = '';
  for await (const chunk of from) {
    const parts = (partial + decoder.decode(chunk, { stream: true })).split('\n');
    partial = parts.pop()!;
    for (const line of parts) process.stdout.write(`${prefix}${line}\n`);
  }
  partial += decoder.decode();
  if (partial) process.stdout.write(`${prefix}${partial}\n`);
}

if (import.meta.main) {
  const install = ensureHarness();
  const env = harnessProcessEnv(install, {
    MPW_REPO_ROOT: `${PROVIDER_DIR}/../..`,
    MPW_HARNESS_SRC: install.src,
    ...(process.env.MPW_REQUIRE_HARNESS ? { MPW_REQUIRE_HARNESS: process.env.MPW_REQUIRE_HARNESS } : {}),
    ...(process.env.MPW_GBRAIN_CLI ? { MPW_GBRAIN_CLI: process.env.MPW_GBRAIN_CLI } : {}),
  });
  const args = process.argv.slice(2);
  const junitDir = args.find(a => a.startsWith('--junit-dir='))?.slice('--junit-dir='.length);
  if (!junitDir) {
    const proc = Bun.spawnSync([install.python, '-m', 'pytest', ...args], { cwd: PROVIDER_DIR, env, stdout: 'inherit', stderr: 'inherit' });
    process.exit(proc.exitCode ?? 1);
  }
  mkdirSync(junitDir, { recursive: true });
  const rest = args.filter(a => !a.startsWith('--junit-dir='));
  const codes = await Promise.all(GROUPS.map(async (group, i) => {
    const report = resolve(junitDir, `pytest-${i + 1}.xml`);
    const proc = Bun.spawn([install.python, '-m', 'pytest', ...group, `--junitxml=${report}`, '-o', 'junit_family=xunit1', ...rest], { cwd: PROVIDER_DIR, env, stdout: 'pipe', stderr: 'pipe' });
    const prefix = `[pytest ${i + 1}] `;
    const [, , code] = await Promise.all([lines(proc.stdout, prefix), lines(proc.stderr, prefix), proc.exited]);
    if (code === 0 && !existsSync(report)) { console.error(`${prefix}no JUnit report at ${report}`); return 1; }
    return code;
  }));
  const failed = codes.flatMap((c, i) => (c === 0 ? [] : [i + 1]));
  console.log(`\n${GROUPS.length} pytest groups: ${failed.length ? `failing groups ${failed.join(', ')}` : 'all passed'}`);
  process.exit(failed.length ? 1 : 0);
}

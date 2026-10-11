/**
 * Run the Python tests for eval/harness-provider/ inside the pinned harness
 * venv (installing it first if needed). Extra arguments go to pytest.
 *
 *   bun run harness:test [-- -k name]
 */
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR } from './harness-env.ts';

const install = ensureHarness();
const proc = Bun.spawnSync([install.python, '-m', 'pytest', ...process.argv.slice(2)], {
  cwd: PROVIDER_DIR,
  env: harnessProcessEnv(install, {
    MPW_REPO_ROOT: `${PROVIDER_DIR}/../..`,
    MPW_HARNESS_SRC: install.src,
    ...(process.env.MPW_REQUIRE_HARNESS ? { MPW_REQUIRE_HARNESS: process.env.MPW_REQUIRE_HARNESS } : {}),
  }),
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 1);

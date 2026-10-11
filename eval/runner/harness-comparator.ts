/**
 * Install or inspect the comparator's pinned current release, which runs as a
 * separate server beside the harness (see eval/harness-provider/mpw/comparator_server.py).
 * Installs the harness venv first if needed, then runs the Python CLI in it.
 *
 *   bun run harness:comparator install     install (idempotent) into .harness/comparator/<version>/
 *   bun run harness:comparator check       exit 1 unless the install matches comparator.lock.json
 *   bun run harness:comparator describe    print versions, models and what the proxy meters
 */
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, REPO_ROOT } from './harness-env.ts';

const install = ensureHarness();
const proc = Bun.spawnSync([install.python, '-m', 'mpw.comparator_server', ...process.argv.slice(2)], {
  cwd: PROVIDER_DIR,
  env: harnessProcessEnv(install, { MPW_REPO_ROOT: REPO_ROOT }),
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 1);

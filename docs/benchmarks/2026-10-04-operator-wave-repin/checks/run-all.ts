// Runs every check for the re-pin to gbrain 739e5cc against one gbrain and writes one receipt.
//   bun docs/benchmarks/2026-10-04-operator-wave-repin/checks/run-all.ts <receipt.json>            # the pinned dependency
//   GBRAIN_ROOT=<gbrain checkout with node_modules> bun .../run-all.ts <receipt.json>             # another commit
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GBRAIN_ROOT, GBRAIN_VERSION } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const CHECKS = ['grant-hint-token-id', 'edit-page-diff-order', 'segment-gap-5918', 'chronicle-receipt-keyless'];
const REPO = resolve(import.meta.dir, '../../../..');
const out = process.argv[2];
if (!out) throw new Error('usage: run-all.ts <receipt.json>');
const git = (cwd: string, ...a: string[]) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
const pkg = await Bun.file(join(REPO, 'package.json')).json();
const loadedHead = git(GBRAIN_ROOT, 'rev-parse', 'HEAD');
const results = [];
for (const name of CHECKS) {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, `${name}.ts`)], { cwd: REPO, env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let parsed: unknown = null;
  try { parsed = JSON.parse(stdout); } catch { /* kept raw below */ }
  results.push({ check: name, exit_code: code, seconds: Math.round((performance.now() - started) / 100) / 10, result: parsed, ...(parsed ? {} : { stdout_tail: stdout.slice(-2000) }), stderr_tail: stderr.slice(-1000) });
  console.error(`${name}: exit ${code}`);
}
const receipt = {
  kind: 'operator-wave-repin-checks',
  date: new Date().toISOString(),
  bun: Bun.version,
  gbrain: {
    version: GBRAIN_VERSION,
    root: process.env.GBRAIN_ROOT ? 'GBRAIN_ROOT checkout' : 'node_modules/gbrain (pinned dependency)',
    loaded_git_head: loadedHead && GBRAIN_ROOT.includes('node_modules') ? null : loadedHead,
    declared_pin: pkg.dependencies.gbrain,
  },
  gbrain_evals: { git_head: git(REPO, 'rev-parse', 'HEAD'), dirty: (git(REPO, 'status', '--porcelain') ?? '') !== '' },
  keys: 'every *_API_KEY, *_TOKEN, *_BASE_URL and GBRAIN_* variable removed; no model call',
  results,
};
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
console.error(`${results.filter(r => r.exit_code === 0).length}/${results.length} checks exited 0 -> ${out}`);

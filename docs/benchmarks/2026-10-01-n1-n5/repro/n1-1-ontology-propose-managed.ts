/**
 * N1-1 repro: ontology_propose (CLI `gbrain ontology-add`) is refused on a
 * brain made by a plain `gbrain init`, because it inserts into `facts`
 * outside the persistence coordinator and the managed-writer guard trigger
 * rejects it. Keyless, temp GBRAIN_HOME, pinned gbrain.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-1-ontology-propose-managed.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'n1-1-'));
const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1' };
const gbrain = (...args: string[]) => spawnSync('bun', [join(import.meta.dir, '../../../../node_modules/gbrain/src/cli.ts'), ...args], { env, encoding: 'utf8' });
try {
  gbrain('init', '--pglite', '--path', join(home, 'brain.pglite'), '--no-embedding', '--non-interactive');
  const add = gbrain('ontology-add', 'people/alice-example', 'location', 'Lisbon');
  console.log('ontology-add exit', add.status, '|', (add.stdout + add.stderr).trim().split('\n').at(-1));
  const call = gbrain('call', 'ontology_propose', JSON.stringify({ entity: 'people/alice-example', dimension: 'location', value: 'Lisbon', visibility: 'world' }));
  console.log('call ontology_propose exit', call.status, '|', (call.stdout + call.stderr).trim().split('\n').at(-1));
  const get = gbrain('call', 'ontology_get', JSON.stringify({ entity: 'people/alice-example' }));
  console.log('ontology_get ->', get.stdout.trim());
} finally {
  rmSync(home, { recursive: true, force: true });
}

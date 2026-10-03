/**
 * N5-3 repro: on PGLite, the first trusted CLI `remember` of a corrected
 * claim right after a `forget` on the same entity fails with scope_denied
 * ("The source file bytes changed after this request was accepted."); an
 * identical retry succeeds. Keyless, temp GBRAIN_HOME, pinned gbrain.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-3-remember-after-forget-pglite.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliDriver, runCli } from '../../../../eval/runner/lifecycle/drivers.ts';

const home = mkdtempSync(join(tmpdir(), 'n5-3-'));
const run = { buildDir: join(import.meta.dir, '../../../../node_modules/gbrain'), env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1' } };
try {
  await runCli(run, ['init', '--pglite', '--path', join(home, 'brain.pglite'), '--no-embedding', '--non-interactive']);
  const d = new CliDriver(run);
  await d.call('put_page', { slug: 'people/hazel-example', content: '---\ntitle: Hazel Example\ntype: person\n---\nFictional.\n' });
  const r = await d.call('remember', { fact: 'Keeps bees cnryreproaaaa', entity: 'people/hazel-example', provenance: 'repro', visibility: 'world' });
  const f = await d.call('forget', { id: String((r.data as { id: string }).id), reason: 'repro' });
  const corrected = { fact: 'Gave up beekeeping cnryreprobbbb', entity: 'people/hazel-example', provenance: 'repro', visibility: 'world' };
  const first = await d.call('remember', corrected);
  const retry = first.ok ? null : await d.call('remember', corrected);
  console.log('forget:', f.ok ? 'ok' : f.error);
  console.log('first remember of the corrected claim (expected ok):', first.ok ? 'ok' : first.error);
  console.log('identical retry:', retry ? (retry.ok ? 'ok' : retry.error) : 'not needed');
} finally {
  rmSync(home, { recursive: true, force: true });
}

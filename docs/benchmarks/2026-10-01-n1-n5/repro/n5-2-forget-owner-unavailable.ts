/**
 * N5-2 repro: with concurrent trusted CLI writes on PGLite, a forget's
 * rebuild effects can stay queued, whether the call returns ok or
 * owner_unavailable (it commits either way). The page keeps no chunks, so
 * the retained fact on the same page is missing from search until some
 * later write drains the queue. Timing dependent: five rounds, each printed.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-2-forget-owner-unavailable.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliDriver, runCli } from '../../../../eval/runner/lifecycle/drivers.ts';

const buildDir = join(import.meta.dir, '../../../../node_modules/gbrain');
for (let round = 1; round <= 5; round++) {
  const home = mkdtempSync(join(tmpdir(), 'n5-2-'));
  const run = { buildDir, env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1' } };
  try {
    await runCli(run, ['init', '--pglite', '--path', join(home, 'brain.pglite'), '--no-embedding', '--non-interactive']);
    const d = new CliDriver(run);
    for (const n of ['ivy', 'hazel']) await d.call('put_page', { slug: `people/${n}-example`, content: `---\ntitle: ${n} Example\ntype: person\n---\nFictional.\n` });
    const id = String(((await d.call('remember', { fact: 'Keeps bees cnryreproaaaa', entity: 'people/ivy-example', provenance: 'repro', visibility: 'world' })).data as { id: string }).id);
    await d.call('remember', { fact: 'Plays the oboe cnryreprobbbb', entity: 'people/ivy-example', provenance: 'repro', visibility: 'world' });
    const [forget] = await Promise.all([
      d.call('forget', { id, reason: 'repro' }),
      ...['c', 'd', 'e', 'f'].map(t => d.call('remember', { fact: `Grows bonsai cnryrepro${t.repeat(4)}`, entity: 'people/hazel-example', provenance: 'repro', visibility: 'world' })),
    ]);
    const recall = JSON.stringify((await d.call('recall', { entity: 'people/ivy-example' })).data);
    const search = JSON.stringify((await d.call('search', { query: 'cnryreprobbbb' })).data);
    console.log(`round ${round}: forget -> ${forget.ok ? 'ok' : forget.error?.split(':')[0]}; forgotten fact active: ${recall.includes('cnryreproaaaa')}; retained neighbor in recall: ${recall.includes('cnryreprobbbb')}, in search (expected true): ${search.includes('cnryreprobbbb')}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

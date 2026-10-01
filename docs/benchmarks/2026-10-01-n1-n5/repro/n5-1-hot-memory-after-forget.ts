/**
 * N5-1 repro: after `forget`, a running `gbrain serve` keeps serving the
 * withdrawn fact from its hot-memory cache for up to 30 seconds, both in
 * context_pack's hot facts and in the `_meta.brain_hot_memory` block it
 * attaches to every other tool response. The cache (src/core/facts/meta-hook.ts,
 * 30 s TTL) is never invalidated: bumpHotMemoryCache has no caller.
 * Keyless, temp GBRAIN_HOME, pinned gbrain, stdio MCP.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n5-1-hot-memory-after-forget.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpStdioDriver, runCli } from '../../../../eval/runner/lifecycle/drivers.ts';

const home = mkdtempSync(join(tmpdir(), 'n5-1-'));
const run = { buildDir: join(import.meta.dir, '../../../../node_modules/gbrain'), env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1' } };
const marker = 'cnryreprohive';
const d = new McpStdioDriver(run);
try {
  await runCli(run, ['init', '--pglite', '--path', join(home, 'brain.pglite'), '--no-embedding', '--non-interactive']);
  await d.start();
  await d.call('put_page', { slug: 'people/alice-example', content: '---\ntitle: Alice Example\ntype: person\n---\nAlice.\n' });
  const r = await d.call('remember', { fact: `Keeps bees ${marker}`, entity: 'people/alice-example', provenance: 'repro', visibility: 'world' });
  const id = String((r.data as { id: string }).id);
  // The put_page response above cached an empty hot memory for 30 s; wait it out so the cache holds the fact.
  await new Promise(res => setTimeout(res, 31_000));
  const before = await d.call('context_pack', { entities: 'people/alice-example' });
  console.log('context_pack before forget carries the fact:', JSON.stringify(before.data).includes(marker));
  const f = await d.call('forget', { id, reason: 'repro' });
  console.log('forget ok:', f.ok, '| recall after forget carries it:', JSON.stringify((await d.call('recall', { entity: 'people/alice-example' })).data).includes(marker));
  const after = await d.call('context_pack', { entities: 'people/alice-example' });
  console.log('context_pack right after forget carries it (expected false):', JSON.stringify(after.data).includes(marker));
  const page = await d.call('get_page', { slug: 'people/alice-example' });
  console.log('get_page _meta.brain_hot_memory right after forget carries it (expected false):', JSON.stringify(page.meta ?? null).includes(marker));
} finally {
  await d.close();
  rmSync(home, { recursive: true, force: true });
}

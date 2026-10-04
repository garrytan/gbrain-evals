// Fix wave 8 (integrator 9aa88eb31): the sixth and later searches in one PGLite process no longer stall.
// Imports 2,000 linked notes, opens one `gbrain serve` stdio session (an agent's MCP connection) and times ten
// `search` calls in a row. Exit 0 when the preregistered expectation holds (item D4).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, gbrain, keylessHome, mcpSession } from './lib.ts';

const PAGES = 2000;
const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const dir = mkdtempSync(join(tmpdir(), 'w8f1-scale-'));
const words = ['harbor', 'orchard', 'lantern', 'meadow', 'quarry', 'canyon', 'glacier', 'prairie', 'delta', 'summit'];
for (let i = 1; i <= PAGES; i++) {
  const links = [i + 1, i + 7, i + 31].map(j => ((j - 1) % PAGES) + 1).map(j => `[Example note ${j}](example-note-${j}.md)`).join(', ');
  writeFileSync(join(dir, `example-note-${i}.md`), `---\ntitle: Example note ${i}\n---\nExample note ${i} covers the ${words[i % 10]} project and the ${words[(i * 3) % 10]} review. See ${links}.\n`);
}
const t0 = performance.now();
const imported = await gbrain(['import', dir, '--no-embed'], h.env);
const importMs = performance.now() - t0;
const mcp = await mcpSession(h.env, h.home);
const times: number[] = [];
const hits: number[] = [];
for (let i = 0; i < 10; i++) {
  const started = performance.now();
  const r = await mcp.call('search', { query: `${words[i]} project review`, limit: 10 });
  times.push(Math.round(performance.now() - started));
  hits.push((r.text.match(/example-note-\d+/g) ?? []).length);
}
await mcp.close();
h.cleanup();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const early = median(times.slice(1, 5));
const late = Math.max(...times.slice(5));
finish('search-stall-2k', {
  setup_ok: imported.code === 0 && /2000 pages imported/.test(imported.stdout),
  D4_every_search_returned_results: hits.every(n => n > 0),
  D4_late_searches_not_stalled: late <= Math.max(500, 10 * early),
}, { pages: PAGES, import_ms: Math.round(importMs), search_ms: times, early_median_ms_2_to_5: early, late_max_ms_6_to_10: late, hits });

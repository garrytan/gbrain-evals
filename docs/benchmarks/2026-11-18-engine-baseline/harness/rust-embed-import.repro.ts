// Run from the gbrain-evals root: bun docs/benchmarks/2026-11-18-engine-baseline/harness/rust-embed-import.repro.ts
// Minimal repro: one embedded import on each engine, same gbrain build, stub (hash) embeddings, no provider request.
import { openScratchEvalEngine } from '../../../../eval/runner/eval-engine.ts';
import { resolveGbrainUnderTest } from '../../../../eval/runner/gbrain-under-test.ts';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { importFromContent } from 'gbrain/import-file';
const dims = 1536;
const hash = (t: string) => Array.from({ length: dims }, (_, i) => Math.sin((t.length + 1) * (i + 1)));
process.env.OPENAI_API_KEY ??= 'dummy';
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: process.env as any });
__setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(hash), values, warnings: [] })) as any);
const gut = resolveGbrainUnderTest(null);
for (const kind of ['pglite', 'postgres', 'rust'] as const) {
  const s = await openScratchEvalEngine({ gut, kind, label: 'repro', pgAdminUrl: process.env.BENCH_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres' });
  try {
    const r = await importFromContent(s.engine as any, 'concepts/example', '---\ntype: concept\ntitle: Example\n---\n\n# Example\n\nA short body about latency budgets.');
    const n = await (s.engine as any).getChunks('concepts/example', { includeEmbedding: true });
    console.log(kind, 'OK', JSON.stringify({ status: (r as any).status, chunks: n.length, embedded: n.filter((c: any) => c.embedding).length }));
  } catch (e) {
    console.log(kind, 'REFUSED', (e as any)?.code ?? '', String((e as Error).message).slice(0, 300));
    console.log(String((e as Error).stack).split('\n').filter(l => l.includes('/src/')).slice(0, 4).join('\n'));
  } finally { await s.close(); }
}
process.exit(0);

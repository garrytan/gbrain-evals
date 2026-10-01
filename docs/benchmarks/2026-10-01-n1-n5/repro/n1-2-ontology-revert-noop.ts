/**
 * N1-2 repro: an ontology revert (A, then B, then A again, all with the
 * default provenance "manual") is stored as a no-op, so the current value
 * stays B. mergeOntologyFact's ON CONFLICT key (source, entity, dimension,
 * value_hash, source_markdown_slug) has no time component. Runs in process on
 * an unmanaged in-memory PGLite engine (the N3 setup), so N1-1 does not mask it.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-2-ontology-revert-noop.ts
 */
const root = '../../../../node_modules/gbrain/src/core';
const { PGLiteEngine } = await import(`${root}/pglite-engine.ts`);
const { operations } = await import(`${root}/operations.ts`);
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' };
const op = (name: string, p: Record<string, unknown>) => operations.find((o: { name: string }) => o.name === name)!.handler(ctx, p);
for (const [value, valid_from] of [['Lisbon', '2020-01-01'], ['Porto', '2022-01-01'], ['Lisbon', '2024-01-01']]) {
  const r = await op('ontology_propose', { entity: 'people/alice-example', dimension: 'location', value, valid_from, visibility: 'world' }) as { action: string };
  console.log(`propose ${value} from ${valid_from} -> ${r.action}`);
}
const now = await op('ontology_get', { entity: 'people/alice-example' }) as Array<{ value: string }>;
console.log('current location (expected Lisbon):', now.map(r => r.value).join(', '));
await engine.disconnect();

/**
 * N1-3 repro: ontology_get returns an observation written with
 * visibility "private" to a remote (stdio or HTTP) caller. Only
 * diary-sourced rows and rows whose provenance page is private are filtered.
 * Runs in process on an unmanaged in-memory PGLite engine.
 *
 *   bun docs/benchmarks/2026-10-01-n1-n5/repro/n1-3-ontology-private-remote.ts
 */
const root = '../../../../node_modules/gbrain/src/core';
const { PGLiteEngine } = await import(`${root}/pglite-engine.ts`);
const { operations } = await import(`${root}/operations.ts`);
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const ctx = (remote: boolean) => ({ engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote, sourceId: 'default' });
const op = (name: string, remote: boolean, p: Record<string, unknown>) => operations.find((o: { name: string }) => o.name === name)!.handler(ctx(remote), p);
await op('ontology_propose', false, { entity: 'people/alice-example', dimension: 'risk_tolerance', value: 'high (private marker)', visibility: 'private' });
await op('ontology_propose', false, { entity: 'people/alice-example', dimension: 'decision_style', value: 'deliberate', visibility: 'world' });
const remote = await op('ontology_get', true, { entity: 'people/alice-example' }) as Array<{ dimension: string; value: string }>;
console.log('remote ontology_get (expected: decision_style only):', remote.map(r => `${r.dimension}=${r.value}`).join(', '));
await engine.disconnect();

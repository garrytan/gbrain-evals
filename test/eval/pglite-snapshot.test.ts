import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { coldPath, currentShape, snapshotPaths } from '../support/pglite-snapshot.ts';

const snapshotLoaded = (engine: PGLiteEngine) => (engine as unknown as { _snapshotLoaded?: boolean })._snapshotLoaded === true;

async function schemaFingerprint(engine: PGLiteEngine) {
  const columns = await engine.db.query(`SELECT table_name, column_name, data_type, udt_name, column_default, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`);
  const indexes = await engine.db.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`);
  const constraints = await engine.db.query(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY rel, conname`);
  const functions = await engine.db.query(`SELECT proname, pg_get_function_identity_arguments(oid) AS args
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname, args`);
  const config = await engine.db.query(`SELECT key, value FROM config ORDER BY key`);
  return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows, functions: functions.rows, config: config.rows };
}

const engines: PGLiteEngine[] = [];
const scratch: string[] = [];
afterAll(async () => {
  for (const engine of engines) await engine.disconnect().catch(() => {});
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('shared pre-migrated PGLite snapshot (test preload)', () => {
  test('a snapshot-loaded brain has exactly the schema of a cold migration run', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const cold = new PGLiteEngine();
    engines.push(cold);
    await coldPath.connect.call(cold, {});
    await coldPath.initSchema.call(cold);
    expect(snapshotLoaded(cold)).toBe(false);

    const warm = new PGLiteEngine();
    engines.push(warm);
    await warm.connect({});
    await warm.initSchema();
    expect(snapshotLoaded(warm)).toBe(true);
    expect(snapshotPaths(currentShape())?.contents).toContain('dims=1536\nmodel=openai:text-embedding-3-large');

    expect(await schemaFingerprint(warm)).toEqual(await schemaFingerprint(cold));
  }, 120_000);

  test('each embedding shape gets its own snapshot', async () => {
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: {} });
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({});
    await engine.initSchema();
    expect(snapshotLoaded(engine)).toBe(true);
    const dims = await engine.db.query(`SELECT atttypmod FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
    expect((dims.rows[0] as { atttypmod: number }).atttypmod).toBe(1024);
  }, 120_000);

  test('changing the embedding shape between connect and initSchema fails loudly', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({});
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: {} });
    await expect(engine.initSchema()).rejects.toThrow(/embedding shape changed/);
  }, 120_000);

  test('persistent brains never load the snapshot', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-evals-persistent-'));
    scratch.push(dir);
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({ database_path: join(dir, 'brain') });
    await engine.initSchema();
    expect(snapshotLoaded(engine)).toBe(false);
  }, 120_000);
});

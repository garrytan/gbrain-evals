/**
 * Test preload: reuse one pre-migrated PGLite cluster per embedding shape.
 *
 * Most suite time used to go to building a fresh in-memory brain and replaying
 * all of gbrain's migrations for every test. gbrain already supports loading
 * a post-`initSchema()` dump through `GBRAIN_PGLITE_SNAPSHOT`, guarded by a
 * schema-source hash and the embedding shape (see `tryLoadSnapshot` in
 * gbrain's `src/core/pglite-engine.ts`). This preload builds that dump once
 * per (schema hash, embedding model, dimensions) under
 * `node_modules/.cache/gbrain-evals/pglite/` and points in-memory engines at
 * it. Persistent (`database_path`) engines are untouched.
 *
 * Set GBRAIN_EVALS_PGLITE_SNAPSHOT=0 to force the original cold path.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine, computeSnapshotSchemaHash } from 'gbrain/pglite-engine';
import { getEmbeddingDimensions, getEmbeddingModel } from 'gbrain/ai/gateway';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../../node_modules/gbrain/src/core/ai/defaults.ts';

type Shape = { model: string; dims: number };
type EngineConfig = Parameters<PGLiteEngine['connect']>[0];

export const SNAPSHOT_DIR = join(import.meta.dir, '..', '..', 'node_modules', '.cache', 'gbrain-evals', 'pglite');

export function currentShape(): Shape {
  try {
    return { model: getEmbeddingModel(), dims: getEmbeddingDimensions() };
  } catch {
    return { model: DEFAULT_EMBEDDING_MODEL, dims: DEFAULT_EMBEDDING_DIMENSIONS };
  }
}

const shapeKey = (shape: Shape) => `${shape.model}@${shape.dims}`;
const schemaHash = computeSnapshotSchemaHash(crypto, fs);

export function snapshotPaths(shape: Shape, dir = SNAPSHOT_DIR): { tar: string; version: string; contents: string } | null {
  if (!schemaHash) return null;
  const stem = `${schemaHash.slice(0, 16)}-${shape.model.replace(/[^a-zA-Z0-9.-]+/g, '_')}-${shape.dims}`;
  return {
    tar: join(dir, `${stem}.tar`),
    version: join(dir, `${stem}.version`),
    contents: `${schemaHash}\ndims=${shape.dims}\nmodel=${shape.model}\n`,
  };
}

const originalConnect = PGLiteEngine.prototype.connect;
const originalInitSchema = PGLiteEngine.prototype.initSchema;
export const coldPath = { connect: originalConnect, initSchema: originalInitSchema };
const building = new Map<string, Promise<string | null>>();
const loadedShape = new WeakMap<PGLiteEngine, string>();

async function bake(shape: Shape): Promise<string | null> {
  const paths = snapshotPaths(shape);
  if (!paths) return null;
  try {
    if (fs.existsSync(paths.tar) && fs.readFileSync(paths.version, 'utf8') === paths.contents) return paths.tar;
  } catch { /* rebuild */ }
  const saved = { home: process.env.GBRAIN_HOME, snapshot: process.env.GBRAIN_PGLITE_SNAPSHOT };
  const scratch = fs.mkdtempSync(join(tmpdir(), 'gbrain-evals-snapshot-'));
  const engine = new PGLiteEngine();
  try {
    process.env.GBRAIN_HOME = scratch;
    delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    await originalConnect.call(engine, {});
    await originalInitSchema.call(engine);
    const data = new Uint8Array(await (await engine.db.dumpDataDir('none')).arrayBuffer());
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const token = `${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(`${paths.tar}.${token}.tmp`, data);
    fs.writeFileSync(`${paths.version}.${token}.tmp`, paths.contents);
    fs.renameSync(`${paths.tar}.${token}.tmp`, paths.tar);
    fs.renameSync(`${paths.version}.${token}.tmp`, paths.version);
    return paths.tar;
  } catch (error) {
    console.warn(`[pglite-snapshot] cold init fallback for ${shapeKey(shape)}: ${String(error)}`);
    return null;
  } finally {
    try { await engine.disconnect(); } catch { /* best effort */ }
    for (const [key, value] of [['GBRAIN_HOME', saved.home], ['GBRAIN_PGLITE_SNAPSHOT', saved.snapshot]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function ensureSnapshot(shape: Shape): Promise<string | null> {
  const key = shapeKey(shape);
  let pending = building.get(key);
  if (!pending) {
    pending = bake(shape);
    building.set(key, pending);
  }
  return pending;
}

if (process.env.GBRAIN_EVALS_PGLITE_SNAPSHOT !== '0') {
  PGLiteEngine.prototype.connect = async function (this: PGLiteEngine, config: EngineConfig) {
    if (config?.database_path || process.env.GBRAIN_PGLITE_SNAPSHOT) return originalConnect.call(this, config);
    const shape = currentShape();
    const tar = await ensureSnapshot(shape);
    if (!tar) return originalConnect.call(this, config);
    process.env.GBRAIN_PGLITE_SNAPSHOT = tar;
    try {
      await originalConnect.call(this, config);
    } finally {
      if (process.env.GBRAIN_PGLITE_SNAPSHOT === tar) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    }
    if ((this as unknown as { _snapshotLoaded?: boolean })._snapshotLoaded) loadedShape.set(this, shapeKey(shape));
  };

  PGLiteEngine.prototype.initSchema = async function (this: PGLiteEngine) {
    const loaded = loadedShape.get(this);
    if (loaded && loaded !== shapeKey(currentShape())) {
      throw new Error(`[pglite-snapshot] embedding shape changed from ${loaded} to ${shapeKey(currentShape())} between connect() and initSchema(); `
        + 'configure the gateway before connect(), or run with GBRAIN_EVALS_PGLITE_SNAPSHOT=0');
    }
    return originalInitSchema.call(this);
  };
}

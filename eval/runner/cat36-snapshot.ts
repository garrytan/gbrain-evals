import { createHash } from 'node:crypto';
import { cpSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cat36Hash } from './cat36-corpus.ts';
import type { Cat36BuildReceipt, Cat36Profile } from './cat36-associative-retrieval.ts';
import { loadReceipt } from './receipt.ts';

export interface Cat36IndexSnapshot { path: string; sha256: string }

export function cat36SnapshotHash(path: string): string {
  const hash = createHash('sha256');
  const walk = (relative: string) => {
    for (const name of readdirSync(join(path, relative)).sort()) {
      const key = join(relative, name);
      const stat = lstatSync(join(path, key));
      if (stat.isSymbolicLink()) throw new Error('snapshot contains an unverifiable symlink');
      if (stat.isDirectory()) walk(key);
      else if (stat.isFile()) {
        const bytes = readFileSync(join(path, key));
        hash.update(`${Buffer.byteLength(key)}:${key}:${bytes.length}:`).update(bytes);
      }
    }
  };
  walk('');
  return hash.digest('hex');
}

export function copyCat36Snapshot(snapshot: Cat36IndexSnapshot, destination: string): void {
  if (cat36SnapshotHash(snapshot.path) !== snapshot.sha256) throw new Error('frozen cue index content changed');
  cpSync(snapshot.path, destination, { recursive: true, errorOnExist: true, force: false });
  if (cat36SnapshotHash(destination) !== snapshot.sha256) throw new Error('copied cue index differs from frozen construction');
}

export function loadCat36FrozenConstruction(directory: string, profile: Cat36Profile, sourceHash: string, packageHash: unknown): Cat36BuildReceipt {
  const root = realpathSync(resolve(directory));
  const receipt = loadReceipt(join(root, 'receipt.json'));
  const raw = readFileSync(join(root, 'build.json'));
  const { frozen_at, profile_hash, ...build } = JSON.parse(raw.toString()) as Cat36BuildReceipt & { frozen_at: string; profile_hash: string };
  const original = build.construction_profile;
  if (receipt.category !== 'cat36-associative-retrieval' || receipt.hashes?.build !== cat36Hash(raw)
    || JSON.stringify(build) !== JSON.stringify(receipt.data?.build) || receipt.data?.runtime_kind !== 'production'
    || !Number.isFinite(Date.parse(frozen_at)) || build.runtime_kind !== 'production' || build.mode !== 'live'
    || !build.complete || !build.generation_observed || !original || original.arm !== 'C1'
    || profile_hash !== cat36Hash(JSON.stringify(original)) || !build.index_snapshot
    || JSON.stringify([...build.families].sort()) !== JSON.stringify(['horizon', 'scene'])) throw new Error('read-time ablation requires verified production C1 construction');
  if (build.source_hash !== sourceHash || build.provenance.package_sha256 !== packageHash || typeof packageHash !== 'string') throw new Error('frozen construction source/product identity mismatch');
  for (const field of ['expected_product_sha', 'embedding_model', 'embedding_dimensions', 'generation_model', 'expansion_model', 'cue_min_similarity', 'cue_weight', 'token_budget', 'search_config'] as const) {
    if (JSON.stringify(original[field]) !== JSON.stringify(profile[field])) throw new Error(`read-time ablation changed ${field}`);
  }
  const path = realpathSync(resolve(root, build.index_snapshot.path));
  if (!path.startsWith(root + '/')) throw new Error('frozen index must belong to its original run');
  if (cat36SnapshotHash(path) !== build.index_snapshot.sha256) throw new Error('frozen cue index content changed');
  return { ...build, index_snapshot: { ...build.index_snapshot, path } };
}

/**
 * BEAM for the streaming harness: one split's conversations only. A dev run
 * downloads and reads only the dev conversations' files; the sealed split is
 * opened by the custodian (`--split sealed`), never by the feature author.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { beamManifest, DATASET_ROOT, loadBeam, type Corpus } from '../memory-qa/corpus.ts';
import { loadSplit } from '../decisions/splits.ts';

export type BeamSize = '100k' | '500k' | '1m';

export function splitIds(size: BeamSize, split: 'dev' | 'sealed'): Set<string> {
  const s = loadSplit(`beam-${size}`);
  return new Set(split === 'dev' ? s.dev : s.sealed);
}

/** Downloads (pinned SHA-256) only the given conversations' chat and question files. */
export async function fetchBeamConversations(size: BeamSize, ids: ReadonlySet<string>): Promise<number> {
  const m = beamManifest();
  let fetched = 0;
  for (const c of m.sizes[size].filter(x => ids.has(x.conversation))) {
    for (const [rel, sha] of [[c.chat_path, c.chat_sha256], [c.questions_path, c.questions_sha256]] as const) {
      const path = join(DATASET_ROOT, 'beam', rel);
      if (existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === sha) continue;
      const res = await fetch(m.raw_base + rel);
      if (!res.ok) throw new Error(`download failed (${res.status}) for ${rel}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`${rel}: bytes do not match the pinned SHA-256`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      fetched++;
    }
  }
  return fetched;
}

export async function loadBeamSplit(size: BeamSize, split: 'dev' | 'sealed'): Promise<Corpus> {
  const ids = splitIds(size, split);
  await fetchBeamConversations(size, ids);
  return loadBeam(size, ids);
}

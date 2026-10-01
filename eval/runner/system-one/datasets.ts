/**
 * System One v1 datasets: the registry (eval/data/system-one-v1/datasets.json),
 * gbrain's dataset hashes recomputed here, and the staging that rebuilds the
 * two datasets this repository does not store as built files.
 *
 * gbrain's `decide calibrate` records `datasetHash` (sha256 of the file text,
 * first 16 hex characters) and `split_hash` (sha256 over the sorted
 * `id:split` lines, first 16 hex). Both are reimplemented below so the
 * hermetic check does not depend on the gbrain code under test.
 *
 * S7 triage and S8 grounding embed Cat 35 transcripts. The Cat 35 corpus
 * already lives in eval/data/transcript-distill-v1, so only the 230 synthetic
 * S7 transcripts and the S8 labels are committed. `stageS7` and `stageS8`
 * recreate the directory layout gbrain's builder read, byte for byte, and
 * `gbrain decide dataset` then reproduces the frozen JSONL (checked by hash).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const DATA_DIR = join(REPO_ROOT, 'eval/data/system-one-v1');
export const CAT35_DIR = join(REPO_ROOT, 'eval/data/transcript-distill-v1');
export const M_PILOT_SELECTION = join(REPO_ROOT, 'eval/data/longmemeval-m-pilot-selection.json');

export type LabelSource = 'upstream-gold' | 'synthetic-construction' | `llm:${string}` | 'human';

export interface DatasetEntry {
  id: string;
  slot: string;
  /** committed: the built JSONL is in DATA_DIR. rebuilt: staged from committed inputs and built with gbrain. external: built from a downloaded benchmark file. */
  build: 'committed' | 'rebuilt' | 'external';
  /** Path relative to DATA_DIR for committed datasets; the output name otherwise. */
  file: string;
  dataset_hash16: string;
  split_hash: string;
  items: number;
  families: number;
  calibrate: number;
  eval: number;
  /** Label source -> item count. Every label in this release is generator, LLM or benchmark annotation; none is human. */
  label_provenance: Record<string, number>;
  label_note: string;
  /** For rebuilt datasets: sha256 over the staged input tree (see treeHash). */
  staged_tree_sha256?: string;
  build_command?: string;
  source?: { name: string; url: string; sha256: string; license: string };
}

export interface DatasetsFile {
  schema_version: 1;
  upstream: { repo: string; branch: string; commit: string; path: string };
  datasets: DatasetEntry[];
  inputs: Record<string, { sha256: string; note: string }>;
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function datasetHash16(text: string): string {
  return sha256(text).slice(0, 16);
}

export interface DatasetLine { id: string; family: string; slot: string; split: 'calibrate' | 'eval'; label: boolean | string; label_source?: string; origin?: string }

export function parseDatasetLines(text: string): DatasetLine[] {
  return text.split('\n').filter(line => line.trim()).map((line, n) => {
    const raw = JSON.parse(line) as DatasetLine;
    if (typeof raw.id !== 'string' || typeof raw.family !== 'string' || typeof raw.slot !== 'string') throw new Error(`line ${n + 1}: id, family and slot are required`);
    if (raw.split !== 'calibrate' && raw.split !== 'eval') throw new Error(`line ${n + 1}: split must be calibrate or eval`);
    return raw;
  });
}

export function splitHash(items: readonly Pick<DatasetLine, 'id' | 'split'>[]): string {
  return sha256(items.map(i => `${i.id}:${i.split}`).sort().join('\n')).slice(0, 16);
}

export interface DatasetStats { dataset_hash16: string; split_hash: string; items: number; families: number; calibrate: number; eval: number; label_provenance: Record<string, number> }

/** The HASHES.md columns for one dataset file. Lines without `label_source` count as `unmarked`. */
export function datasetStats(text: string): DatasetStats {
  const items = parseDatasetLines(text);
  const provenance: Record<string, number> = {};
  for (const item of items) {
    const key = `${item.label_source ?? 'unmarked'}${item.origin ? ` (${item.origin})` : ''}`;
    provenance[key] = (provenance[key] ?? 0) + 1;
  }
  const calibrate = items.filter(i => i.split === 'calibrate').length;
  return {
    dataset_hash16: datasetHash16(text), split_hash: splitHash(items), items: items.length,
    families: new Set(items.map(i => i.family)).size, calibrate, eval: items.length - calibrate, label_provenance: provenance,
  };
}

export function loadDatasets(): DatasetsFile {
  return JSON.parse(readFileSync(join(DATA_DIR, 'datasets.json'), 'utf8')) as DatasetsFile;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** sha256 over the sorted `relative/path sha256(bytes)` lines of every file under dir. */
export function treeHash(dir: string): string {
  return sha256(walk(dir).map(f => `${relative(dir, f)} ${sha256(readFileSync(f))}`).sort().join('\n'));
}

const CAT35_UPSTREAM_NOTE = 'garrytan/gbrain-evals eval/data/transcript-distill-v1 (MIT; synthetic, generator claude-opus-4-5)';

/**
 * Recreate gbrain's docs/eval/system-one/datasets/s7-triage layout: the 24 Cat 35
 * transcripts with their gold reduced to the triage label, plus the 230
 * synthetic transcripts committed here. Returns the staged directory.
 */
export function stageS7(outDir: string): string {
  const dir = join(outDir, 's7-triage');
  mkdirSync(join(dir, 'gold'), { recursive: true });
  mkdirSync(join(dir, 'transcripts-txt'), { recursive: true });
  for (const name of readdirSync(join(CAT35_DIR, 'gold')).filter(f => f.endsWith('.json')).sort()) {
    const gold = JSON.parse(readFileSync(join(CAT35_DIR, 'gold', name), 'utf8')) as { schema_version: number; transcript_id: string; scenario: string; expected_triage: string };
    const projected = {
      schema_version: gold.schema_version, transcript_id: gold.transcript_id, scenario: gold.scenario,
      expected_triage: gold.expected_triage, label_source: 'upstream-gold', upstream: CAT35_UPSTREAM_NOTE,
    };
    writeFileSync(join(dir, 'gold', name), `${JSON.stringify(projected, null, 2)}\n`);
  }
  for (const name of readdirSync(join(CAT35_DIR, 'transcripts-txt')).filter(f => f.endsWith('.txt')).sort()) {
    copyFileSync(join(CAT35_DIR, 'transcripts-txt', name), join(dir, 'transcripts-txt', name));
  }
  const synthetic = join(DATA_DIR, 's7-triage-synthetic');
  for (const sub of ['gold', 'transcripts-txt']) {
    for (const name of readdirSync(join(synthetic, sub)).sort()) copyFileSync(join(synthetic, sub, name), join(dir, sub, name));
  }
  return dir;
}

/** The gbrain repository path S8's labels.jsonl uses in `transcript_path`. */
export const S8_TRANSCRIPT_PREFIX = 'docs/eval/system-one/datasets/s8-grounding/transcripts/';

/**
 * Recreate the tree S8's builder ran in: labels.jsonl plus the 16 Cat 35
 * transcripts it references, at the relative paths the labels name. The
 * builder must run with the returned root as its working directory.
 */
export function stageS8(outDir: string): { root: string; labels: string; transcripts: string } {
  const root = join(outDir, 's8-root');
  const transcripts = join(root, S8_TRANSCRIPT_PREFIX);
  mkdirSync(transcripts, { recursive: true });
  const labelsText = readFileSync(join(DATA_DIR, 's8-grounding/labels.jsonl'), 'utf8');
  const paths = new Set(labelsText.split('\n').filter(l => l.trim()).map(l => (JSON.parse(l) as { transcript_path: string }).transcript_path));
  for (const path of paths) {
    if (!path.startsWith(S8_TRANSCRIPT_PREFIX)) throw new Error(`unexpected S8 transcript_path ${path}`);
    copyFileSync(join(CAT35_DIR, 'transcripts-txt', path.slice(S8_TRANSCRIPT_PREFIX.length)), join(root, path));
  }
  const labels = join(root, 'docs/eval/system-one/datasets/s8-grounding/labels.jsonl');
  writeFileSync(labels, labelsText);
  return { root, labels, transcripts };
}

/** The 28-question LongMemEval-M pilot list, derived from the committed selection (gbrain's m-pilot-28.txt). */
export function mPilotIds(): string {
  const selection = JSON.parse(readFileSync(M_PILOT_SELECTION, 'utf8')) as { selected_ids: string[] };
  return `${selection.selected_ids.join('\n')}\n`;
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { buildCueWindows } from '../../node_modules/gbrain/src/core/memory-cues/windows.ts';
import { renderSession } from './longmemeval.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function main() {
  const [sourcePath, expectedHash] = process.argv.slice(2);
  if (!sourcePath || !/^[a-f0-9]{64}$/.test(expectedHash ?? '') || process.argv.length !== 4) {
    throw new Error('usage: bun eval/runner/longmemeval-m-pilot-import-check.ts <source-only.json> <expected-source-sha256>');
  }
  const sourceBytes = readFileSync(resolve(sourcePath));
  if (hash(sourceBytes) !== expectedHash) throw new Error('source hash mismatch');
  const sources = JSON.parse(sourceBytes.toString()) as Array<{ occurrence_index: number; session_id: string; date: string; turns: Array<{ role: 'user' | 'assistant'; content: string }> }>;
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const stats = { sessions: 0, persisted_chunks: 0, cue_windows: 0, max_embedding_chars: 0, max_embedding_bytes: 0,
    max_chunks_per_session: 0, max_windows_per_session: 0, import_failures: 0, source_modality: {} as Record<string, number> };
  try {
    for (const source of sources) {
      if (source.occurrence_index !== stats.sessions) throw new Error('source occurrence order changed');
      const slug = `chat/${source.session_id}-occ-${source.occurrence_index}`.toLowerCase();
      const imported = await importFromContent(engine, slug, renderSession(source), { noEmbed: true });
      if (imported.status === 'error') {
        stats.import_failures++;
        throw new Error(`import rejected selected source occurrence ${source.occurrence_index}: ${imported.error}`);
      }
      const persisted = await engine.getChunks(slug);
      if (persisted.length !== imported.chunks) throw new Error(`import/getChunks disagreement at occurrence ${source.occurrence_index}`);
      const windows = buildCueWindows(persisted.filter(chunk => chunk.chunk_source === 'compiled_truth' || chunk.chunk_source === 'timeline'));
      stats.persisted_chunks += persisted.length;
      stats.cue_windows += windows.length;
      stats.max_chunks_per_session = Math.max(stats.max_chunks_per_session, persisted.length);
      stats.max_windows_per_session = Math.max(stats.max_windows_per_session, windows.length);
      for (const chunk of persisted) {
        stats.max_embedding_chars = Math.max(stats.max_embedding_chars, chunk.chunk_text.length);
        stats.max_embedding_bytes = Math.max(stats.max_embedding_bytes, Buffer.byteLength(chunk.chunk_text));
        const label = `${chunk.chunk_source}/${chunk.modality ?? 'text'}`;
        stats.source_modality[label] = (stats.source_modality[label] ?? 0) + 1;
      }
      stats.sessions++;
      if (stats.sessions % 100 === 0) process.stderr.write(`[longmemeval-m-pilot] keyless imported ${stats.sessions}/${sources.length} source occurrences\n`);
    }
    console.log(JSON.stringify({ source_sha256: expectedHash, stats }));
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
